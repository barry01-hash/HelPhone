#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, String,
};

mod multisig;
mod nonce;

pub use multisig::{Proposal, ProposalAction};

// ── Storage Keys ───────────────────────────────────────────────────
//
// Instance (cheap, contract-lifetime):
//   "admin"   → Address          current admin
//   "pending" → Address          pending new owner (optional)
//   "rcount"  → u64              total requests ever created
//   "acount"  → u32              number of active request IDs
//   ("active", u32) → u64        active request IDs by slot index
//
// Persistent (pay-to-live):
//   ("req", u64) → HelpRequest
//   ("rcount", request_id) → u32   responder count per request
//   ("resp", request_id, idx) → ResponderRecord
//   ("evcount", wallet) → u32      verification count per wallet
//   ("ev", wallet, idx) → ExpertVerification
//
// ── Footprint contract (client mirror: src/lib/footprint.ts, issue #517) ──
// The JS client inspects each invocation's storage footprint via an RPC
// simulateTransaction call before any user signature, then caches the returned
// read-only / read-write ledger-key set in memory and reuses it for identical
// repeat invocations.
//
//   * mark_arrived / resolve_request / cancel_request touch only
//     ("req", id) / ("resp", request_id, responder_index) — fully determined
//     by the function arguments, so the client pre-bakes their footprint.
//   * create_request / accept_request / record_expert_verification append to
//     counter/slot keys whose values depend on on-chain state; their footprint
//     is left to the pre-sign simulation to derive.
//
// Both checks read config from the instance/"admin" slot; multisig state lives
// in the multisig module (multisig::configuration). Keep this map in sync with
// any storage key added here.

fn key_admin() -> soroban_sdk::Symbol {
    symbol_short!("admin")
}
fn key_pending() -> soroban_sdk::Symbol {
    symbol_short!("pending")
}
fn key_req_count() -> soroban_sdk::Symbol {
    symbol_short!("rcount")
}
fn key_active_count() -> soroban_sdk::Symbol {
    symbol_short!("acount")
}

// ── Error Codes ────────────────────────────────────────────────────
#[contracterror]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
    NotFound = 1,
    NotAuthorized = 2,
    AlreadyExists = 3,
    WrongStatus = 4,
    NoPendingTransfer = 5,
    TransferAlreadyPending = 6,
    InvalidThreshold = 7,
    NotMultisigSigner = 8,
    DuplicateApproval = 9,
    ThresholdNotMet = 10,
    ProposalExecuted = 11,
}

// ── Types ──────────────────────────────────────────────────────────
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub enum Status {
    Pending,
    Enroute,
    Resolved,
    Cancelled,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct HelpRequest {
    pub id: u64,
    pub requester: Address,
    /// Latitude encoded as integer (degrees × 1_000_000)
    pub lat: i32,
    /// Longitude encoded as integer (degrees × 1_000_000)
    pub lng: i32,
    pub emergency_type: String,
    pub nickname: String,
    pub contact: String,
    pub status: Status,
    pub created_at: u64,
    pub resolved_at: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct ResponderRecord {
    pub responder: Address,
    pub lat: i32,
    pub lng: i32,
    pub eta_seconds: u32,
    pub arrived: bool,
    pub responded_at: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct ExpertVerification {
    pub wallet: Address,
    pub action: String,
    pub tx_hash: String,
    pub proof_fingerprint: String,
    pub recorded_at: u64,
}

#[contract]
pub struct HelPhone;

#[contractimpl]
impl HelPhone {
    // ── Initialisation ──────────────────────────────────────────────

    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&key_admin(), &admin);
        env.storage().instance().set(&key_req_count(), &0u64);
        env.storage().instance().set(&key_active_count(), &0u32);
        multisig::initialise(&env, &admin);
    }

    // ── Admin reads ─────────────────────────────────────────────────

    pub fn get_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&key_admin())
    }

    pub fn get_pending_owner(env: Env) -> Option<Address> {
        env.storage().instance().get(&key_pending())
    }

    // ── M-of-N multisig governance ──────────────────────────────────

    pub fn configure_multisig(
        env: Env,
        caller: Address,
        admins: soroban_sdk::Vec<Address>,
        threshold: u32,
    ) -> Result<(), Error> {
        caller.require_auth();
        let admin: Address = env
            .storage()
            .instance()
            .get(&key_admin())
            .ok_or(Error::NotAuthorized)?;
        if caller != admin {
            return Err(Error::NotAuthorized);
        }
        let (_, current_threshold) = multisig::configuration(&env);
        if current_threshold > 1 {
            return Err(Error::ThresholdNotMet);
        }
        if !multisig::configure(&env, &admins, threshold) {
            return Err(Error::InvalidThreshold);
        }
        env.storage().instance().remove(&key_pending());
        Ok(())
    }

    pub fn get_multisig_config(env: Env) -> (soroban_sdk::Vec<Address>, u32) {
        multisig::configuration(&env)
    }

    pub fn create_admin_proposal(
        env: Env,
        proposer: Address,
        new_admin: Address,
    ) -> Result<Proposal, Error> {
        proposer.require_auth();
        if !multisig::is_signer(&env, &proposer) {
            return Err(Error::NotMultisigSigner);
        }
        Ok(multisig::create(
            &env,
            &proposer,
            ProposalAction::TransferAdmin(new_admin),
        ))
    }

    pub fn get_admin_proposal(env: Env, id: u64) -> Option<Proposal> {
        multisig::get(&env, id)
    }

    pub fn approve_admin_proposal(env: Env, id: u64, signer: Address) -> Result<Proposal, Error> {
        signer.require_auth();
        if !multisig::is_signer(&env, &signer) {
            return Err(Error::NotMultisigSigner);
        }
        multisig::approve(&env, id, &signer).ok_or(Error::DuplicateApproval)
    }

    pub fn execute_admin_proposal(env: Env, id: u64) -> Result<(), Error> {
        let mut proposal = multisig::get(&env, id).ok_or(Error::NotFound)?;
        if proposal.executed {
            return Err(Error::ProposalExecuted);
        }
        let (_, threshold) = multisig::configuration(&env);
        if proposal.approvals < threshold {
            return Err(Error::ThresholdNotMet);
        }
        match proposal.action.clone() {
            ProposalAction::TransferAdmin(new_admin) => {
                env.storage().instance().set(&key_admin(), &new_admin)
            }
        }
        multisig::mark_executed(&env, &mut proposal);
        Ok(())
    }

    // ── Request reads ───────────────────────────────────────────────

    pub fn get_request_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&key_req_count())
            .unwrap_or(0u64)
    }

    pub fn get_active_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&key_active_count())
            .unwrap_or(0u32)
    }

    /// Return the request ID stored at active-list slot `index`.
    pub fn get_active_request_id(env: Env, index: u32) -> Option<u64> {
        env.storage()
            .instance()
            .get(&(symbol_short!("active"), index))
    }

    pub fn get_request(env: Env, id: u64) -> Option<HelpRequest> {
        env.storage().persistent().get(&(symbol_short!("req"), id))
    }

    pub fn get_responder_count(env: Env, request_id: u64) -> u32 {
        env.storage()
            .persistent()
            .get(&(symbol_short!("rcount"), request_id))
            .unwrap_or(0u32)
    }

    pub fn get_responder(env: Env, request_id: u64, index: u32) -> Option<ResponderRecord> {
        env.storage()
            .persistent()
            .get(&(symbol_short!("resp"), request_id, index))
    }

    pub fn get_expert_verification_count(env: Env, wallet: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&(symbol_short!("evcount"), wallet))
            .unwrap_or(0u32)
    }

    pub fn get_expert_verification(
        env: Env,
        wallet: Address,
        index: u32,
    ) -> Option<ExpertVerification> {
        env.storage()
            .persistent()
            .get(&(symbol_short!("ev"), wallet, index))
    }

    // ── Compatibility shim — test snapshot helper ────────────────────
    // The existing test snapshots call get_active_requests() and
    // get_expert_verifications(wallet, limit). We expose read-only helpers
    // that the Rust test suite can call; the JS client uses individual
    // getters above.

    pub fn get_active_requests(env: Env) -> u32 {
        Self::get_active_count(env)
    }

    pub fn get_expert_verifications(env: Env, wallet: Address, limit: u32) -> u32 {
        let total = Self::get_expert_verification_count(env, wallet);
        if limit < total {
            limit
        } else {
            total
        }
    }

    // ── Emergency Request Lifecycle ─────────────────────────────────

    pub fn create_request(
        env: Env,
        requester: Address,
        lat: i32,
        lng: i32,
        emergency_type: String,
        nickname: String,
        contact: String,
    ) -> u64 {
        requester.require_auth();
        let count = Self::get_request_count(env.clone()) + 1;
        env.storage().instance().set(&key_req_count(), &count);
        let req = HelpRequest {
            id: count,
            requester,
            lat,
            lng,
            emergency_type,
            nickname,
            contact,
            status: Status::Pending,
            created_at: env.ledger().timestamp(),
            resolved_at: None,
        };
        env.storage()
            .persistent()
            .set(&(symbol_short!("req"), count), &req);
        // Append to active list
        let active_count = Self::get_active_count(env.clone());
        env.storage()
            .instance()
            .set(&(symbol_short!("active"), active_count), &count);
        env.storage()
            .instance()
            .set(&key_active_count(), &(active_count + 1));
        count
    }

    pub fn accept_request(
        env: Env,
        responder: Address,
        request_id: u64,
        lat: i32,
        lng: i32,
        eta_seconds: u32,
    ) -> Result<u32, Error> {
        responder.require_auth();
        let mut req: HelpRequest = env
            .storage()
            .persistent()
            .get(&(symbol_short!("req"), request_id))
            .ok_or(Error::NotFound)?;
        if req.status != Status::Pending {
            return Err(Error::WrongStatus);
        }
        req.status = Status::Enroute;
        env.storage()
            .persistent()
            .set(&(symbol_short!("req"), request_id), &req);

        let idx: u32 = env
            .storage()
            .persistent()
            .get(&(symbol_short!("rcount"), request_id))
            .unwrap_or(0u32);
        let record = ResponderRecord {
            responder,
            lat,
            lng,
            eta_seconds,
            arrived: false,
            responded_at: env.ledger().timestamp(),
        };
        env.storage()
            .persistent()
            .set(&(symbol_short!("resp"), request_id, idx), &record);
        env.storage()
            .persistent()
            .set(&(symbol_short!("rcount"), request_id), &(idx + 1));
        Ok(idx)
    }

    pub fn mark_arrived(
        env: Env,
        responder: Address,
        request_id: u64,
        responder_index: u32,
    ) -> Result<(), Error> {
        responder.require_auth();
        let mut r: ResponderRecord = env
            .storage()
            .persistent()
            .get(&(symbol_short!("resp"), request_id, responder_index))
            .ok_or(Error::NotFound)?;
        if r.responder != responder {
            return Err(Error::NotAuthorized);
        }
        if r.arrived {
            return Err(Error::AlreadyExists);
        }
        r.arrived = true;
        env.storage()
            .persistent()
            .set(&(symbol_short!("resp"), request_id, responder_index), &r);
        Ok(())
    }

    pub fn resolve_request(env: Env, requester: Address, request_id: u64) -> Result<(), Error> {
        requester.require_auth();
        let mut req: HelpRequest = env
            .storage()
            .persistent()
            .get(&(symbol_short!("req"), request_id))
            .ok_or(Error::NotFound)?;
        if req.requester != requester {
            return Err(Error::NotAuthorized);
        }
        if req.status != Status::Enroute {
            return Err(Error::WrongStatus);
        }
        req.status = Status::Resolved;
        req.resolved_at = Some(env.ledger().timestamp());
        env.storage()
            .persistent()
            .set(&(symbol_short!("req"), request_id), &req);
        Ok(())
    }

    pub fn cancel_request(env: Env, requester: Address, request_id: u64) -> Result<(), Error> {
        requester.require_auth();
        let mut req: HelpRequest = env
            .storage()
            .persistent()
            .get(&(symbol_short!("req"), request_id))
            .ok_or(Error::NotFound)?;
        if req.requester != requester {
            return Err(Error::NotAuthorized);
        }
        if req.status != Status::Pending {
            return Err(Error::WrongStatus);
        }
        req.status = Status::Cancelled;
        env.storage()
            .persistent()
            .set(&(symbol_short!("req"), request_id), &req);
        Ok(())
    }

    pub fn record_expert_verification(
        env: Env,
        wallet: Address,
        action: String,
        tx_hash: String,
        proof_fingerprint: String,
    ) -> Result<u32, Error> {
        wallet.require_auth();
        let count: u32 = env
            .storage()
            .persistent()
            .get(&(symbol_short!("evcount"), wallet.clone()))
            .unwrap_or(0u32);
        let ev = ExpertVerification {
            wallet: wallet.clone(),
            action,
            tx_hash,
            proof_fingerprint,
            recorded_at: env.ledger().timestamp(),
        };
        env.storage()
            .persistent()
            .set(&(symbol_short!("ev"), wallet.clone(), count), &ev);
        env.storage()
            .persistent()
            .set(&(symbol_short!("evcount"), wallet), &(count + 1));
        Ok(count + 1)
    }

    // ── Two-Step Ownership Transfer ─────────────────────────────────
    //
    // Pattern: current owner calls `propose_transfer(new_owner)` which
    // stores `new_owner` under the "pending" key.  The new owner calls
    // `accept_transfer()` to atomically claim ownership.  Either party
    // can call `revoke_transfer()` to cancel the pending handoff.
    //
    // Why two steps instead of single-step?
    //   Single-step (set admin = new_addr) cannot verify that the new
    //   address is reachable and willing to manage the contract.  A typo
    //   irretrievably locks ownership.  The two-step approach requires the
    //   new owner to sign `accept_transfer`, proving they control the key.

    /// Propose transferring ownership to `new_owner`.
    /// Only the current admin may call this.  Replaces any existing
    /// pending transfer (e.g. to correct a typo without revoking first).
    pub fn propose_transfer(
        env: Env,
        current_owner: Address,
        new_owner: Address,
    ) -> Result<(), Error> {
        current_owner.require_auth();
        let (_, threshold) = multisig::configuration(&env);
        if threshold > 1 {
            return Err(Error::ThresholdNotMet);
        }
        let admin: Address = env
            .storage()
            .instance()
            .get(&key_admin())
            .ok_or(Error::NotAuthorized)?;
        if admin != current_owner {
            return Err(Error::NotAuthorized);
        }
        env.storage().instance().set(&key_pending(), &new_owner);
        Ok(())
    }

    /// Accept the pending ownership transfer.
    /// Only the nominated address may call this.  On success the caller
    /// becomes the new admin and the pending slot is cleared.
    pub fn accept_transfer(env: Env, new_owner: Address) -> Result<(), Error> {
        new_owner.require_auth();
        let pending: Address = env
            .storage()
            .instance()
            .get(&key_pending())
            .ok_or(Error::NoPendingTransfer)?;
        if pending != new_owner {
            return Err(Error::NotAuthorized);
        }
        env.storage().instance().set(&key_admin(), &new_owner);
        env.storage().instance().remove(&key_pending());
        Ok(())
    }

    /// Revoke a pending ownership transfer.
    /// Callable by either the current admin (cancels their proposal) or
    /// the nominated new_owner (declines the handoff).
    pub fn revoke_transfer(env: Env, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        let pending: Address = env
            .storage()
            .instance()
            .get(&key_pending())
            .ok_or(Error::NoPendingTransfer)?;
        let admin: Address = env
            .storage()
            .instance()
            .get(&key_admin())
            .ok_or(Error::NotAuthorized)?;
        if caller != admin && caller != pending {
            return Err(Error::NotAuthorized);
        }
        env.storage().instance().remove(&key_pending());
        Ok(())
    }
}

#[cfg(test)]
mod test;
