"""
units_client.py — UNITS API client for Python 3.10+ (requests + cryptography).

    pip install requests cryptography

SERVER-SIDE ONLY. The developer token identifies your organisation; never expose it to browsers/apps.

Mirrors units-client.ts:
  * envelope builder: POST /v1/... with
        {"context": {id, version, ts, msgId, developerToken, authorization?, valueFormat?},
         "payload": {...}, "signature"?: {keyId, jws}}
    The developer token and user JWT go IN THE BODY. No Authorization header is read by UNITS.
  * call(): ok = HTTP 2xx AND context.status != "failed"; data in body["response"];
    error in body["context"]["error"] {code, message}; 429 Retry-After; timeouts; X-Correlation-ID.
  * OTP login/signup, address hashing sha256(lower(trim(address))).
  * RFC 8785 JCS canonicalisation + Ed25519 signature of `payload` for /v1/token/transact.
  * poll_transaction() with backoff, resolve_token_id() (mint never returns the tokenId).
  * ensure_token_class(): idempotent get -> register for class + class config.
  * SessionManager: refresh-token timer (< 30 min; single-use refresh tokens; single-flight lock).

Verify behaviour against your live instance — some of it is environment-dependent (snapshot 2026-10).

Usage:
    from units_client import UnitsClient
    units = UnitsClient(os.environ["UNITS_BASE_URL"], os.environ["UNITS_DEVELOPER_TOKEN"])
"""

from __future__ import annotations

import base64
import hashlib
import json
import math
import random
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Callable, Literal, Optional

import requests
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

ValueFormat = Literal["raw", "display"]

API_IDS: dict[str, str] = {
    "/v1/account/login": "api.account.login",
    "/v1/account/create": "api.account.create",
    "/v1/account/refresh": "api.account.refresh",
    "/v1/account/get": "api.account.get",
    "/v1/account/logout": "api.account.logout",
    "/v1/account/keys/register": "api.account.keys.register",
    "/v1/account/keys/search": "api.account.keys.search",
    "/v1/account/keys/get": "api.account.keys.get",
    "/v1/address/checkAvailability": "api.address.checkAvailability",
    "/v1/address/resolve": "api.address.resolve",
    "/v1/tokenclass/register": "api.tokenclass.register",
    "/v1/tokenclass/get": "api.tokenclass.get",
    "/v1/tokenclass/search": "api.tokenclass.search",
    "/v1/tokenclass/update": "api.tokenclass.update",
    "/v1/tokenclassconfig/register": "api.tokenclassconfig.register",
    "/v1/tokenclassconfig/get": "api.tokenclassconfig.get",
    "/v1/tokenclassconfig/update": "api.tokenclassconfig.update",
    "/v1/tokenprogram/search": "api.tokenprogram.search",
    "/v1/tokenprogram/get": "api.tokenprogram.get",
    "/v1/token/mint": "api.token.mint",
    "/v1/token/add": "api.token.add",
    "/v1/token/transact": "api.token.transact",
    "/v1/token/get": "api.token.get",
    "/v1/token/search": "api.token.search",
    "/v1/token/transactions": "api.token.transactions",
    "/v1/transaction/status": "api.transaction.status",
    "/v1/transaction/get": "api.transaction.get",
    "/v1/transaction/search": "api.transaction.search",
    "/v1/transaction/proof": "api.transaction.proof",
    "/v1/transaction/proof/leaf": "api.transaction.proof.leaf",
    "/v1/transaction/proof/verify": "api.transaction.proof.verify",
    "/v1/transactions/status": "api.transactions.status",
    "/v1/delegations/list": "api.delegations.list",
    "/v1/delegations/check": "api.delegations.check",
    "/v1/workflows/execute": "api.workflow.execute",
    "/v1/workflows/status": "api.workflow.status",
}

# Reads/polls are safe to retry. Writes are NOT (UNITS has no idempotency key; retries can duplicate).
RETRY_SAFE_PATHS = {
    p
    for p in API_IDS
    if p.endswith(("/get", "/search", "/status", "/transactions", "/list", "/check", "/proof", "/leaf", "/verify", "/resolve", "/checkAvailability"))
}
# context.valueFormat is ONLY accepted on these routes; other routes' closed context schema rejects it (400).
VALUE_FORMAT_PATHS = {"/v1/token/get", "/v1/token/search", "/v1/token/mint", "/v1/token/transact"}
RETRYABLE_HTTP = {429, 502, 503, 504}
IN_FLIGHT_STATUSES = {"submitted", "pending", "processing", "executing"}
TERMINAL_STATUSES = {"completed", "failed", "cancelled"}


# ------------------------------------------------------------------------------------------------
# Results & errors
# ------------------------------------------------------------------------------------------------


@dataclass
class UnitsResult:
    ok: bool
    http_status: int
    msg_id: str
    context_status: Optional[str] = None
    data: Any = None  # body["response"]
    error: Optional[dict] = None  # {"code", "message"}
    correlation_id: Optional[str] = None
    raw: Any = None


class UnitsApiError(Exception):
    def __init__(self, result: UnitsResult, where: str):
        self.result = result
        self.http_status = result.http_status
        self.code = (result.error or {}).get("code") or f"HTTP_{result.http_status}"
        super().__init__(f"{where}: {self.code}: {(result.error or {}).get('message', 'request failed')}")


@dataclass
class PollResult:
    tx_id: str
    status: str
    timed_out: bool
    attempts: int
    error: Optional[dict] = None
    raw: Optional[dict] = None


# ------------------------------------------------------------------------------------------------
# Identity helpers
# ------------------------------------------------------------------------------------------------


def hash_address(plaintext_address: str) -> str:
    """sha256(lower(trim(address))) hex, no 0x. == JWT preferred_username. NOT the DID.
    Record it at signup: /v1/account/get returns the address masked."""
    return hashlib.sha256(plaintext_address.strip().lower().encode("utf-8")).hexdigest()


def decode_jwt_payload(jwt: str) -> dict:
    """Decode WITHOUT verification — only for tokens UNITS just handed you."""
    raw = jwt[7:] if jwt.startswith("Bearer ") else jwt
    part = raw.split(".")[1]
    part += "=" * (-len(part) % 4)
    return json.loads(base64.urlsafe_b64decode(part))


def preferred_username_from_jwt(jwt: str) -> str:
    v = decode_jwt_payload(jwt).get("preferred_username")
    if not v:
        raise ValueError("JWT has no preferred_username claim")
    return v


def is_valid_units_address(address: str) -> bool:
    return re.fullmatch(r"[a-z0-9._-]{1,255}", address) is not None


# ------------------------------------------------------------------------------------------------
# RFC 8785 JCS + Ed25519
# ------------------------------------------------------------------------------------------------


def _jcs_number(n: float | int) -> str:
    """ECMAScript Number::toString for finite numbers (what RFC 8785 requires)."""
    if isinstance(n, bool):
        raise TypeError("bool is not a number")
    if isinstance(n, int):
        if abs(n) >= 2**53:
            raise ValueError("JCS: integers beyond 2^53 lose precision — send them as strings")
        return str(n)
    if not math.isfinite(n):
        raise ValueError("JCS: non-finite numbers are not allowed")
    if n == 0:
        return "0"
    if n.is_integer() and abs(n) < 1e21:
        return str(int(n))
    r = repr(n)  # shortest round-trip digits, e.g. '1e-07', '1.5e+22', '0.1'
    mantissa, _, exp = r.partition("e")
    digits = mantissa.replace("-", "").replace(".", "").lstrip("0") or "0"
    # decimal exponent of the first significant digit
    if exp:
        e10 = int(exp) + (len(mantissa.replace("-", "").split(".")[0]) - 1)
    else:
        intpart, _, frac = mantissa.replace("-", "").partition(".")
        if intpart.strip("0"):
            e10 = len(intpart.lstrip("0")) - 1
        else:
            e10 = -(len(frac) - len(frac.lstrip("0")) + 1)
    digits = digits.rstrip("0") or "0"
    sign = "-" if n < 0 else ""
    k, nexp = len(digits), e10 + 1
    if k <= nexp <= 21:
        return sign + digits + "0" * (nexp - k)
    if 0 < nexp <= 21:
        return sign + digits[:nexp] + "." + digits[nexp:]
    if -6 < nexp <= 0:
        return sign + "0." + "0" * (-nexp) + digits
    e = nexp - 1
    m = digits[0] + ("." + digits[1:] if k > 1 else "")
    return f"{sign}{m}e{'+' if e > 0 else '-'}{abs(e)}"


def _jcs_string(s: str) -> str:
    # json.dumps(ensure_ascii=False) escapes exactly ", \\ and control chars (\b\f\n\r\t short forms,
    # others \u00xx lowercase) — the same set RFC 8785 / ECMAScript JSON.stringify escape.
    return json.dumps(s, ensure_ascii=False)


def canonicalize(value: Any) -> str:
    """RFC 8785 canonical JSON. Keys sorted by UTF-16 code units. Keep amounts as strings anyway."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return _jcs_number(value)
    if isinstance(value, str):
        return _jcs_string(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonicalize(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys(), key=lambda k: k.encode("utf-16-be"))
        return "{" + ",".join(f"{_jcs_string(k)}:{canonicalize(value[k])}" for k in keys) + "}"
    raise TypeError(f"JCS: unsupported type {type(value).__name__}")


class Ed25519Signer:
    """Self-custodied Ed25519 key used for the envelope `signature` on /v1/token/transact.

    Register the public key once per UNITS account (with that account's session):
        POST /v1/account/keys/register {"publicKey": signer.public_key_hex(), "type": "ed25519"}
    and use the returned `id` as key_id.
    """

    def __init__(self, private_key: Ed25519PrivateKey, key_id: str = ""):
        self._key = private_key
        self.key_id = key_id

    @classmethod
    def generate(cls, key_id: str = "") -> "Ed25519Signer":
        return cls(Ed25519PrivateKey.generate(), key_id)

    @classmethod
    def from_seed_hex(cls, seed_hex: str, key_id: str) -> "Ed25519Signer":
        seed = bytes.fromhex(seed_hex.removeprefix("0x"))
        if len(seed) != 32:
            raise ValueError("Ed25519 seed must be 32 bytes")
        return cls(Ed25519PrivateKey.from_private_bytes(seed), key_id)

    def with_key_id(self, key_id: str) -> "Ed25519Signer":
        return Ed25519Signer(self._key, key_id)

    def public_key_hex(self) -> str:
        return self._key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw).hex()

    def seed_hex(self) -> str:
        return self._key.private_bytes(
            serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption()
        ).hex()

    def sign_payload(self, payload: Any) -> dict:
        """{keyId, jws}: standard-base64 RAW Ed25519 signature over JCS(payload) bytes."""
        if not self.key_id:
            raise ValueError("signer has no key_id — register the public key first")
        sig = self._key.sign(canonicalize(payload).encode("utf-8"))
        return {"keyId": self.key_id, "jws": base64.b64encode(sig).decode("ascii")}


# ------------------------------------------------------------------------------------------------
# Client
# ------------------------------------------------------------------------------------------------


def _bearer(token: str) -> str:
    return token if token.startswith("Bearer ") else f"Bearer {token}"


def _retry_after_seconds(header: Optional[str], fallback: float) -> float:
    if not header:
        return fallback
    try:
        return max(0.0, float(header))
    except ValueError:
        try:
            return max(0.0, (parsedate_to_datetime(header) - datetime.now(timezone.utc)).total_seconds())
        except (TypeError, ValueError):
            return fallback


class UnitsClient:
    def __init__(
        self,
        base_url: str,
        developer_token: str,
        *,
        version: str = "1.0",
        timeout_s: float = 30.0,
        max_retries: int = 3,
        logger: Optional[Callable[[dict], None]] = None,
        session: Optional[requests.Session] = None,
    ):
        if not base_url or not developer_token:
            raise ValueError("base_url and developer_token are required")
        self.base_url = base_url.rstrip("/")
        self._developer_token = developer_token
        self.version = version
        self.timeout_s = timeout_s
        self.max_retries = max_retries
        self.logger = logger
        self.http = session or requests.Session()

    # -- envelope ---------------------------------------------------------------------------------

    def build_envelope(
        self,
        path: str,
        payload: Any,
        *,
        authorization: Optional[str] = None,
        value_format: Optional[ValueFormat] = None,
        signature: Optional[dict] = None,
        debug: bool = False,
    ) -> dict:
        context: dict[str, Any] = {
            "id": API_IDS.get(path, "api" + path.removeprefix("/v1").replace("/", ".")),
            "version": self.version,
            "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "msgId": str(uuid.uuid4()),  # fresh per attempt
            "developerToken": self._developer_token,
        }
        # context is additionalProperties:false — only known keys.
        if authorization:
            context["authorization"] = _bearer(authorization)
        if value_format and path in VALUE_FORMAT_PATHS:  # elsewhere valueFormat is a 400
            context["valueFormat"] = value_format
        if debug:
            context["debug"] = True
        body: dict[str, Any] = {"context": context, "payload": payload if payload is not None else {}}
        if signature:
            body["signature"] = signature
        return body

    def call(
        self,
        path: str,
        payload: Any = None,
        *,
        authorization: Optional[str] = None,
        value_format: Optional[ValueFormat] = None,
        signature: Optional[dict] = None,
        correlation_id: Optional[str] = None,
        retry: Optional[bool] = None,
        timeout_s: Optional[float] = None,
        debug: bool = False,
    ) -> UnitsResult:
        """POST an envelope. Never raises for API-level failures — check .ok / .error."""
        do_retry = (path in RETRY_SAFE_PATHS) if retry is None else retry
        attempts = self.max_retries + 1 if do_retry else 1
        result: Optional[UnitsResult] = None

        for attempt in range(1, attempts + 1):
            body = self.build_envelope(
                path, payload, authorization=authorization, value_format=value_format, signature=signature, debug=debug
            )
            msg_id = body["context"]["msgId"]
            headers = {"Content-Type": "application/json"}
            if correlation_id:
                headers["X-Correlation-ID"] = correlation_id
            started = time.monotonic()
            http_status, raw, net_err, retry_after, corr = 0, None, None, None, None
            try:
                resp = self.http.post(
                    f"{self.base_url}{path}", data=json.dumps(body), headers=headers, timeout=timeout_s or self.timeout_s
                )
                http_status = resp.status_code
                retry_after = resp.headers.get("Retry-After")
                corr = resp.headers.get("X-Correlation-ID")
                try:
                    raw = resp.json() if resp.content else None
                except ValueError:
                    raw = {"nonJson": resp.text[:500]}
            except requests.RequestException as e:
                net_err = str(e)

            ctx = (raw or {}).get("context") if isinstance(raw, dict) else None
            ctx_status = (ctx or {}).get("status")
            error = (ctx or {}).get("error")
            if net_err:
                error = {"code": "NETWORK_ERROR", "message": net_err}
            elif not error and not (200 <= http_status < 300):
                error = {"code": f"HTTP_{http_status}", "message": json.dumps(raw)[:300]}
            ok = net_err is None and 200 <= http_status < 300 and ctx_status != "failed"
            result = UnitsResult(
                ok=ok,
                http_status=http_status,
                msg_id=msg_id,
                context_status=ctx_status,
                data=raw.get("response") if isinstance(raw, dict) else None,
                error=None if ok else error,
                correlation_id=corr,
                raw=raw,
            )
            if self.logger:
                self.logger(
                    {
                        "path": path,
                        "apiId": body["context"]["id"],
                        "attempt": attempt,
                        "httpStatus": http_status,
                        "contextStatus": ctx_status,
                        "errorCode": (result.error or {}).get("code"),
                        "errorMessage": (result.error or {}).get("message"),
                        "durationMs": int((time.monotonic() - started) * 1000),
                        "correlationId": corr,
                        "msgId": msg_id,
                    }
                )
            retryable = not ok and (net_err is not None or http_status in RETRYABLE_HTTP)
            if not retryable or attempt == attempts:
                break
            backoff = min(30.0, 0.5 * 2 ** (attempt - 1)) + random.random() * 0.25
            time.sleep(_retry_after_seconds(retry_after, backoff) if http_status == 429 else backoff)
        assert result is not None
        return result

    def call_or_raise(self, path: str, payload: Any = None, **kw: Any) -> Any:
        r = self.call(path, payload, **kw)
        if not r.ok:
            raise UnitsApiError(r, path)
        return r.data

    # -- accounts ---------------------------------------------------------------------------------

    def send_otp(self, username: str) -> dict:
        """May send a real email/SMS even on sandbox."""
        return self.call_or_raise("/v1/account/login", {"username": username})

    def verify_otp(self, username: str, otp: str) -> dict:
        """Sandbox accepts "123456". isExisting False => accessToken is an OTP JWT for create only.
        Account homed on another instance => 409 FORWARD."""
        return self.call_or_raise("/v1/account/login", {"username": username, "otp": otp})

    def create_account(self, otp_jwt: str, address: str, name: str, entity_type: Literal["PERSONAL", "BUSINESS"]) -> dict:
        """Returns session tokens + address + addressHash. Persist BOTH address and hash now."""
        address = address.strip().lower()
        if not is_valid_units_address(address):
            raise ValueError(f"invalid UNITS address: {address}")
        tokens = self.call_or_raise(
            "/v1/account/create",
            {"address": address, "name": name, "entityType": entity_type},
            authorization=otp_jwt,
        )
        address_hash = hash_address(address)
        try:
            claimed = preferred_username_from_jwt(tokens["accessToken"])
        except (ValueError, KeyError, IndexError):
            claimed = None
        if claimed is not None and claimed != address_hash:
            raise RuntimeError("preferred_username != sha256(address) — investigate before proceeding")
        return {**tokens, "address": address, "addressHash": address_hash}

    def login_or_signup(
        self,
        username: str,
        otp_provider: Callable[[], str],
        signup: Optional[dict] = None,
    ) -> dict:
        """signup = {"address", "name", "entityType"} used only for new users."""
        self.send_otp(username)
        login = self.verify_otp(username, otp_provider())
        if login.get("isExisting"):
            return {"session": login, "created": False, "addressHash": preferred_username_from_jwt(login["accessToken"])}
        if not signup:
            raise RuntimeError(f"{username} has no UNITS account and no signup details were supplied")
        created = self.create_account(login["accessToken"], signup["address"], signup["name"], signup["entityType"])
        return {"session": created, "created": True, "address": created["address"], "addressHash": created["addressHash"]}

    def refresh(self, refresh_token: str) -> dict:
        """Refresh tokens are single-use: reuse => 401 SESSION_REVOKED."""
        return self.call_or_raise("/v1/account/refresh", {"refreshToken": refresh_token})

    def get_account(self, session: str) -> dict:
        return self.call_or_raise("/v1/account/get", {}, authorization=session)

    def register_signing_key(self, session: str, public_key_hex: str, name: str = "envelope-signing") -> dict:
        return self.call_or_raise(
            "/v1/account/keys/register", {"publicKey": public_key_hex, "type": "ed25519", "name": name}, authorization=session
        )

    # -- token classes ------------------------------------------------------------------------------

    def ensure_token_class(self, definition: dict, operator_session: str) -> dict:
        """Idempotent class + config registration. `definition` = {"register": {...}, "config": {...}}
        (the examples/token-classes/*.json format). The caller becomes the class OWNER."""
        reg_payload = dict(definition["register"])
        token_class = str(reg_payload["tokenClass"]).upper()
        reg_payload["tokenClass"] = token_class
        auth = {"authorization": operator_session}

        class_created = False
        cls = self.call("/v1/tokenclass/get", {"tokenClass": token_class}, **auth)
        if not (cls.ok and (cls.data or {}).get("id")):
            reg = self.call("/v1/tokenclass/register", reg_payload, **auth)
            if reg.ok and (reg.data or {}).get("id"):
                cls, class_created = reg, True
            elif (reg.error or {}).get("code") == "CONFLICT":
                # Exists already — possibly owned by ANOTHER tenant (names are global). Mints would then fail.
                cls = self.call("/v1/tokenclass/get", {"tokenClass": token_class}, **auth)
            else:
                raise UnitsApiError(reg, "tokenclass/register")
        token_class_id = (cls.data or {}).get("id")
        if not token_class_id:
            raise UnitsApiError(cls, "tokenclass/get")

        program_id = definition["config"]["programId"]
        config_created = False
        cfg = self.call("/v1/tokenclassconfig/get", {"tokenClass": token_class}, **auth)
        if cfg.ok:
            bound = (cfg.data or {}).get("programId")
            if bound and bound != program_id:
                raise RuntimeError(f"{token_class} is bound to {bound}, expected {program_id}")
        else:
            cfg_payload = {**definition["config"], "tokenClass": token_class, "tokenClassId": token_class_id}
            self.call_or_raise("/v1/tokenclassconfig/register", cfg_payload, **auth)
            config_created = True
        return {
            "tokenClass": token_class,
            "tokenClassId": token_class_id,
            "classCreated": class_created,
            "configCreated": config_created,
            "programId": program_id,
        }

    # -- writes (async: {txId, status:"submitted"}) --------------------------------------------------

    def mint(self, session: str, payload: dict, *, value_format: ValueFormat = "raw", correlation_id: Optional[str] = None) -> dict:
        """Never include identities[] (caller loses rights => FORBIDDEN no_matching_allow_rule later)."""
        if "identities" in payload:
            raise ValueError("mint(): do not pass identities[]")
        return self.call_or_raise(
            "/v1/token/mint", payload, authorization=session, value_format=value_format, correlation_id=correlation_id, retry=False
        )

    def add_credential(self, payload: dict, *, correlation_id: Optional[str] = None) -> dict:
        """Sessionless token/add (developer token only). owner = sha256 address HASH of the holder.
        Poll the txId with the OWNER's session."""
        if not re.fullmatch(r"[0-9a-f]{64}", payload.get("owner", "")):
            raise ValueError("owner must be the sha256 hex hash of the holder's address")
        return self.call_or_raise("/v1/token/add", payload, correlation_id=correlation_id, retry=False)

    def add_proxy(self, session: str, payload: dict) -> dict:
        """Proxy import/reconcile with the owner's session (walletAddress must be a registered key)."""
        return self.call_or_raise("/v1/token/add", payload, authorization=session, retry=False)

    def transact(
        self,
        session: str,
        payload: dict,
        *,
        signer: Optional[Ed25519Signer] = None,
        value_format: ValueFormat = "raw",
        correlation_id: Optional[str] = None,
    ) -> dict:
        """Generic amount field is `value`, never `amount`. Signature over JCS(payload) when signer given."""
        if "amount" in payload:
            raise ValueError("transact(): use `value`, not `amount`")
        return self.call_or_raise(
            "/v1/token/transact",
            payload,
            authorization=session,
            value_format=value_format,
            signature=signer.sign_payload(payload) if signer else None,
            correlation_id=correlation_id,
            retry=False,
        )

    # -- results ------------------------------------------------------------------------------------

    def poll_transaction(
        self, tx_id: str, session: str, *, timeout_s: float = 120.0, initial_delay_s: float = 1.0, max_delay_s: float = 10.0
    ) -> PollResult:
        """Poll until status leaves {submitted, pending, processing, executing}. Use the initiator's
        (or token identity's) session — for sessionless token/add, the OWNER's session."""
        deadline = time.monotonic() + timeout_s
        delay, attempts, last = initial_delay_s, 0, None
        while True:
            attempts += 1
            r = self.call("/v1/transaction/status", {"txId": tx_id}, authorization=session)
            if not r.ok and r.http_status in (401, 403):
                raise UnitsApiError(r, "transaction/status")
            if r.ok and r.data:
                last = r.data
                if r.data.get("status") not in IN_FLIGHT_STATUSES:
                    return PollResult(tx_id, r.data.get("status", "unknown"), False, attempts, r.data.get("error"), r.data)
            if time.monotonic() + delay > deadline:
                return PollResult(tx_id, (last or {}).get("status", "unknown"), True, attempts, (last or {}).get("error"), last)
            time.sleep(delay)
            delay = min(max_delay_s, delay * 1.5)

    def resolve_token_id(
        self, tx_id: str, session: str, fallback_class: Optional[str] = None, data_filter: Optional[dict] = None
    ) -> Optional[str]:
        tx = self.call("/v1/transaction/get", {"txId": tx_id}, authorization=session)
        if tx.ok and tx.data:
            md = tx.data.get("metadata") or {}
            if md.get("token_id"):  # stamped by units-api when a create op completes
                return md["token_id"]
            affected = md.get("affectedTokenIds")  # written by the engine
            if isinstance(affected, list) and affected:
                return affected[0]
            rd = tx.data.get("responseData") or {}  # legacy builds / proxy flows
            if rd.get("tokenId") or rd.get("id"):
                return rd.get("tokenId") or rd.get("id")
        if not fallback_class:
            return None
        search = self.call(
            "/v1/token/search",
            {
                "filters": {"tokenClass": fallback_class.upper(), **(data_filter or {})},
                "pagination": {"limit": 1, "offset": 0},
                "sortBy": {"field": "createdAt", "order": "desc"},
            },
            authorization=session,
        )
        tokens = (search.data or {}).get("tokens") or []
        return tokens[0].get("id") if tokens else None

    def await_completion(
        self, submitted: dict, session: str, fallback_class: Optional[str] = None, data_filter: Optional[dict] = None,
        *, resolve: bool = True, timeout_s: float = 120.0,
    ) -> dict:
        poll = self.poll_transaction(submitted["txId"], session, timeout_s=timeout_s)
        if poll.timed_out:
            raise TimeoutError(f"tx {poll.tx_id} still {poll.status} — keep polling later; do NOT resubmit blindly")
        if poll.status != "completed":
            err = poll.error or {}
            raise RuntimeError(f"tx {poll.tx_id} {poll.status}: {err.get('code', '')} {err.get('message', '')}".strip())
        token_id = self.resolve_token_id(poll.tx_id, session, fallback_class, data_filter) if resolve else None
        return {"txId": poll.tx_id, "status": poll.status, "tokenId": token_id}

    # -- reads & proofs -----------------------------------------------------------------------------

    def get_token(self, session: str, token_id: str, value_format: ValueFormat = "raw") -> dict:
        return self.call_or_raise("/v1/token/get", {"tokenId": token_id}, authorization=session, value_format=value_format)

    def search_tokens(self, session: str, filters: dict, *, limit: int = 50, offset: int = 0, value_format: ValueFormat = "raw") -> dict:
        return self.call_or_raise(
            "/v1/token/search",
            {"filters": filters, "pagination": {"limit": limit, "offset": offset}, "sortBy": {"field": "createdAt", "order": "desc"}},
            authorization=session,
            value_format=value_format,
        )

    def token_transactions(self, session: str, token_id: str, *, limit: int = 50, offset: int = 0) -> dict:
        return self.call_or_raise(
            "/v1/token/transactions",
            {"filters": {"tokenId": token_id}, "pagination": {"limit": limit, "offset": offset}, "sortBy": {"field": "createdAt", "order": "desc"}},
            authorization=session,
        )

    def get_transaction(self, session: str, tx_id: str) -> dict:
        return self.call_or_raise("/v1/transaction/get", {"txId": tx_id}, authorization=session)

    def get_proof(self, session: str, tx_id: str) -> dict:
        """proofStatus is often 'pending'; chain anchoring is not implemented."""
        return self.call_or_raise("/v1/transaction/proof", {"txId": tx_id}, authorization=session)

    # -- delegations --------------------------------------------------------------------------------

    def grant_delegation(
        self, grantor_session: str, grantee_address: str, label: str, permission: Literal["view", "transact", "manage"],
        expires_at: Optional[str] = None, deny: bool = False,
    ) -> dict:
        """grantee_address = PLAINTEXT address. Labels: tokens:id:<uuid>, tokens:tokenclass:<CLASS>, tokens:*"""
        data: dict[str, Any] = {"grantee_address": grantee_address, "label": label, "permission": permission}
        if expires_at:
            data["expires_at"] = expires_at
        return self.call_or_raise(
            "/v1/workflows/execute",
            {"workflow": "delegation-create", "action": "deny" if deny else "allow", "data": data},
            authorization=grantor_session,
            retry=False,
        )

    def revoke_delegation(self, grantor_session: str, delegation_id: str) -> dict:
        return self.call_or_raise(
            "/v1/workflows/execute",
            {"workflow": "delegation-revoke", "action": "revoke", "data": {"delegation_id": delegation_id}},
            authorization=grantor_session,
            retry=False,
        )

    def list_delegations(self, session: str, filter_: Literal["granted_by_me", "granted_to_me", "pending"]) -> dict:
        return self.call_or_raise("/v1/delegations/list", {"filter": filter_}, authorization=session)

    def check_delegation(self, session: str, token_id: str) -> dict:
        return self.call_or_raise("/v1/delegations/check", {"tokenId": token_id}, authorization=session)


# ------------------------------------------------------------------------------------------------
# SessionManager
# ------------------------------------------------------------------------------------------------


@dataclass
class SessionManager:
    """Keeps one account's session alive. Refresh every 20 min (< 30 min idle timeout) on a daemon
    thread; single-flight via a lock; always store the NEW refresh token (they are single-use).
    If refresh is impossible (no refresh token / SESSION_REVOKED), calls relogin()."""

    client: UnitsClient
    tokens: dict
    relogin: Optional[Callable[[], dict]] = None
    on_tokens: Optional[Callable[[dict], None]] = None
    refresh_every_s: float = 20 * 60
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    _stop: threading.Event = field(default_factory=threading.Event, repr=False)
    _obtained_at: float = field(default_factory=time.time, repr=False)

    def start(self) -> "SessionManager":
        def loop() -> None:
            while not self._stop.wait(self.refresh_every_s):
                try:
                    self.refresh_now()
                except Exception:  # noqa: BLE001 — keep the loop alive; access_token() will retry
                    pass

        threading.Thread(target=loop, name="units-session-refresh", daemon=True).start()
        return self

    def stop(self) -> None:
        self._stop.set()

    def access_token(self) -> str:
        expires_at = self._obtained_at + float(self.tokens.get("expiresIn") or 36000)
        if time.time() > expires_at - 300:
            self.refresh_now()
        return self.tokens["accessToken"]

    def refresh_now(self) -> dict:
        with self._lock:  # single-flight: never present the same refresh token twice
            new: Optional[dict] = None
            if self.tokens.get("refreshToken"):
                try:
                    new = self.client.refresh(self.tokens["refreshToken"])
                except UnitsApiError:
                    new = None  # SESSION_REVOKED / expired -> relogin
            if new is None:
                if not self.relogin:
                    raise RuntimeError("session cannot be refreshed and no relogin() provided")
                new = self.relogin()
            self.tokens, self._obtained_at = new, time.time()
            if self.on_tokens:
                self.on_tokens(new)
            return new


# ------------------------------------------------------------------------------------------------
# Offline self-test: python3 units_client.py selftest
# ------------------------------------------------------------------------------------------------

if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "selftest":
        p = {"tokenId": "0199", "operation": "burn", "value": "10", "data": {"b": 1, "a": [True, None, "é"]}}
        assert canonicalize(p) == '{"data":{"a":[true,null,"é"],"b":1},"operation":"burn","tokenId":"0199","value":"10"}', canonicalize(p)
        for n, want in [(1e-7, "1e-7"), (1e21, "1e+21"), (1e16, "10000000000000000"), (0.1, "0.1"), (-1.5, "-1.5"), (123.456, "123.456"), (1.5e-6, "0.0000015")]:
            assert _jcs_number(n) == want, (n, _jcs_number(n), want)
        s = Ed25519Signer.generate("k1")
        assert Ed25519Signer.from_seed_hex(s.seed_hex(), "k1").sign_payload(p) == s.sign_payload(p)
        print("hash_address('Alice.Example ') =", hash_address("Alice.Example "))
        print("selftest ok")
