//! Cancellation by opaque id, including a cancel that arrives first.
//!
//! The frontend names a job (an AI request, a native LaTeX compile) before it
//! invokes the command that runs it, and it can send Cancel for that name at
//! any moment. Two independent IPC commands are not ordered: a Cancel can reach
//! Rust before the job has registered its flag. A registry that only consults
//! registered flags then drops that Cancel, and the job runs to completion.
//!
//! The Typst preview solves the same race with a numeric watermark
//! (`typst.rs`). These ids are opaque strings, so the string analogue is a
//! small, bounded set of *tombstones*: a Cancel for an unknown id is remembered,
//! and a later registration under that id starts cancelled. Ids are unique per
//! job, so a tombstone for a job that already finished is never matched; the
//! bound keeps such leftovers from accumulating.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::watch;

/// How many early cancels are remembered. A tombstone only has to outlive the
/// gap between two IPC messages; the oldest is dropped beyond this.
pub const TOMBSTONES: usize = 64;

/// Something a registry can set to "stop".
pub trait CancelFlag {
    fn cancel(&self);
}

impl CancelFlag for watch::Sender<bool> {
    fn cancel(&self) {
        self.send_replace(true);
    }
}

impl CancelFlag for Arc<AtomicBool> {
    fn cancel(&self) {
        self.store(true, Ordering::SeqCst);
    }
}

/// Registered jobs by id, plus the cancels that arrived before their job.
pub struct CancelRegistry<F> {
    running: HashMap<String, (u64, F)>,
    early: VecDeque<String>,
    next_ticket: u64,
}

impl<F> Default for CancelRegistry<F> {
    fn default() -> Self {
        Self {
            running: HashMap::new(),
            early: VecDeque::new(),
            next_ticket: 0,
        }
    }
}

/// Proof of one registration; `finish` removes only the job it names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ticket(u64);

impl<F: CancelFlag> CancelRegistry<F> {
    /// Register `flag` under `id`.
    ///
    /// The flag is cancelled before it is stored when a Cancel for `id` already
    /// arrived; the return value says whether that happened. A job registered
    /// under the same id earlier is cancelled: the newer one owns the id.
    pub fn register(&mut self, id: &str, flag: F) -> (Ticket, bool) {
        let early = match self.early.iter().position(|item| item == id) {
            Some(index) => {
                self.early.remove(index);
                flag.cancel();
                true
            }
            None => false,
        };
        self.next_ticket += 1;
        let ticket = self.next_ticket;
        if let Some((_, previous)) = self.running.insert(id.to_string(), (ticket, flag)) {
            previous.cancel();
        }
        (Ticket(ticket), early)
    }

    /// Cancel `id`, now if it is registered, or as soon as it registers.
    pub fn cancel(&mut self, id: &str) {
        if let Some((_, flag)) = self.running.get(id) {
            flag.cancel();
            return;
        }
        if self.early.iter().any(|item| item == id) {
            return;
        }
        if self.early.len() == TOMBSTONES {
            self.early.pop_front();
        }
        self.early.push_back(id.to_string());
    }

    /// Cancel every registered job.
    pub fn cancel_all(&mut self) {
        for (_, flag) in self.running.values() {
            flag.cancel();
        }
    }

    /// Forget a finished job, unless a newer job has taken its id meanwhile.
    pub fn finish(&mut self, id: &str, ticket: Ticket) {
        if self
            .running
            .get(id)
            .is_some_and(|(current, _)| *current == ticket.0)
        {
            self.running.remove(id);
        }
    }

    #[cfg(test)]
    fn tombstones(&self) -> usize {
        self.early.len()
    }

    #[cfg(test)]
    fn registered(&self) -> usize {
        self.running.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flag() -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(false))
    }

    #[test]
    fn a_cancel_after_registration_stops_the_job() {
        let mut registry = CancelRegistry::default();
        let job = flag();
        let (_, early) = registry.register("a", job.clone());
        assert!(!early);
        registry.cancel("a");
        assert!(job.load(Ordering::SeqCst));
        assert_eq!(registry.tombstones(), 0);
    }

    #[test]
    fn a_cancel_before_registration_still_wins() {
        let mut registry = CancelRegistry::default();
        registry.cancel("a");
        let job = flag();
        let (_, early) = registry.register("a", job.clone());
        assert!(early);
        assert!(job.load(Ordering::SeqCst));
        assert_eq!(registry.tombstones(), 0, "a matched tombstone is consumed");
    }

    #[test]
    fn a_tombstone_does_not_cancel_another_id() {
        let mut registry = CancelRegistry::default();
        registry.cancel("a");
        let job = flag();
        let (_, early) = registry.register("b", job.clone());
        assert!(!early);
        assert!(!job.load(Ordering::SeqCst));
    }

    #[test]
    fn tombstones_are_bounded_and_deduplicated() {
        let mut registry = CancelRegistry::<Arc<AtomicBool>>::default();
        registry.cancel("same");
        registry.cancel("same");
        assert_eq!(registry.tombstones(), 1);
        for index in 0..(TOMBSTONES * 2) {
            registry.cancel(&format!("stray-{index}"));
        }
        assert_eq!(registry.tombstones(), TOMBSTONES);
        let job = flag();
        let (_, early) = registry.register("same", job.clone());
        assert!(!early, "the oldest tombstone was dropped");
    }

    #[test]
    fn finish_removes_only_its_own_registration() {
        let mut registry = CancelRegistry::default();
        let first = flag();
        let (old, _) = registry.register("a", first.clone());
        let second = flag();
        let (new, _) = registry.register("a", second.clone());
        assert!(first.load(Ordering::SeqCst), "the newer job owns the id");
        registry.finish("a", old);
        assert_eq!(
            registry.registered(),
            1,
            "a stale finish keeps the newer job"
        );
        registry.cancel("a");
        assert!(second.load(Ordering::SeqCst));
        registry.finish("a", new);
        assert_eq!(registry.registered(), 0);
    }

    #[test]
    fn cancel_all_reaches_every_registered_job() {
        let mut registry = CancelRegistry::default();
        let (a, b) = (flag(), flag());
        registry.register("a", a.clone());
        registry.register("b", b.clone());
        registry.cancel_all();
        assert!(a.load(Ordering::SeqCst) && b.load(Ordering::SeqCst));
    }

    #[test]
    fn a_watch_sender_is_cancelled_through_its_receiver() {
        let mut registry = CancelRegistry::default();
        registry.cancel("ai");
        let (sender, receiver) = watch::channel(false);
        registry.register("ai", sender);
        assert!(*receiver.borrow());
    }
}
