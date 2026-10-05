//! Generation ownership for a viewer bridge while SDP is negotiated off-lock.
use std::collections::{HashMap, HashSet, VecDeque};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct NegotiationTicket {
    generation: u64,
    pub(crate) wire_id: Option<String>,
}

#[derive(Default)]
pub(crate) struct ViewerNegotiations {
    generation: u64,
    current: HashMap<String, NegotiationTicket>,
    closed: HashSet<(String, String)>,
    closed_order: VecDeque<(String, String)>,
}

impl ViewerNegotiations {
    pub(crate) fn begin(&mut self, peer: &str, wire_id: Option<String>) -> Result<NegotiationTicket, String> {
        if wire_id.as_ref().is_some_and(|id| self.closed.contains(&(peer.to_string(), id.clone()))) {
            return Err("Negociação nativa já cancelada".into());
        }
        self.generation += 1;
        let ticket = NegotiationTicket { generation: self.generation, wire_id };
        self.current.insert(peer.to_string(), ticket.clone());
        Ok(ticket)
    }

    pub(crate) fn can_commit(&self, peer: &str, ticket: &NegotiationTicket,
        expected_session: &str, active_session: Option<&str>, live: bool) -> bool {
        live && active_session == Some(expected_session) && self.current.get(peer) == Some(ticket)
    }

    pub(crate) fn matches(&self, peer: &str, wire_id: &Option<String>) -> bool {
        self.current.get(peer).is_some_and(|ticket| &ticket.wire_id == wire_id)
    }

    pub(crate) fn cancel(&mut self, peer: &str, wire_id: &Option<String>) -> bool {
        // Close may reach the command worker before create has reserved its ticket.
        if let Some(id) = wire_id {
            let key = (peer.to_string(), id.clone());
            if self.closed.insert(key.clone()) { self.closed_order.push_back(key); }
            while self.closed_order.len() > 512 {
                if let Some(old) = self.closed_order.pop_front() { self.closed.remove(&old); }
            }
        }
        if !self.matches(peer, wire_id) { return false; }
        self.current.remove(peer);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replacement_and_capture_restart_reject_old_answers() {
        let mut negotiations = ViewerNegotiations::default();
        let old = negotiations.begin("viewer", Some("old".into())).unwrap();
        let new = negotiations.begin("viewer", Some("new".into())).unwrap();
        assert!(!negotiations.can_commit("viewer", &old, "capture-a", Some("capture-a"), true));
        assert!(!negotiations.can_commit("viewer", &new, "capture-a", Some("capture-b"), true));
        assert!(!negotiations.can_commit("viewer", &new, "capture-a", Some("capture-a"), false));
        assert!(negotiations.can_commit("viewer", &new, "capture-a", Some("capture-a"), true));
        // A delayed close for the old bridge must preserve the new negotiation.
        assert!(!negotiations.cancel("viewer", &old.wire_id));
        assert!(negotiations.can_commit("viewer", &new, "capture-a", Some("capture-a"), true));
        assert!(negotiations.cancel("viewer", &new.wire_id));
        assert!(!negotiations.can_commit("viewer", &new, "capture-a", Some("capture-a"), true));
    }
    #[test]
    fn legacy_calls_still_have_distinct_internal_generations() {
        let mut negotiations = ViewerNegotiations::default();
        let old = negotiations.begin("viewer", None).unwrap();
        let new = negotiations.begin("viewer", None).unwrap();
        assert!(!negotiations.can_commit("viewer", &old, "capture", Some("capture"), true));
        assert!(negotiations.can_commit("viewer", &new, "capture", Some("capture"), true));
    }
    #[test]
    fn close_before_create_cannot_resurrect_a_disconnected_viewer() {
        let mut negotiations = ViewerNegotiations::default();
        negotiations.cancel("viewer", &Some("cancelled".into()));
        assert!(negotiations.begin("viewer", Some("cancelled".into())).is_err());
        assert!(negotiations.begin("viewer", Some("reconnected".into())).is_ok());
    }
}
