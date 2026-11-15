//! Coordinate a profile capture with application-owned writers.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

thread_local! {
    static WRITERS_BY_GATE: std::cell::RefCell<std::collections::HashMap<usize, usize>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

#[derive(Default)]
struct State {
    exclusive: bool,
    closing: bool,
    writers: usize,
}

#[derive(Default)]
pub struct Gate {
    state: Mutex<State>,
    changed: Condvar,
}

pub struct Writer<'a> {
    gate: &'a Gate,
    // Reentrant ownership is thread-local; a guard must be dropped by its owner.
    not_send: std::marker::PhantomData<std::rc::Rc<()>>,
}

pub struct Capture<'a> {
    gate: &'a Gate,
    active: bool,
}

pub struct CloseBarrier<'a> {
    gate: &'a Gate,
    active: bool,
}

/// A multi-call, serialized writer (such as a recovered-document revision).
/// Unlike a reentrant Writer it can be retained across IPC worker threads.
pub struct Lease<'a> {
    gate: &'a Gate,
}

impl Gate {
    pub fn lease(&self) -> Result<Lease<'_>, String> {
        self.lease_inner(false)
    }

    fn lease_inner(&self, allow_close: bool) -> Result<Lease<'_>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "The data operation is unavailable.")?;
        if state.exclusive || (state.closing && !allow_close) {
            return Err(
                "An application-data backup or restore is in progress. Try again when it finishes."
                    .into(),
            );
        }
        state.writers = state
            .writers
            .checked_add(1)
            .ok_or("Too many data operations are running.")?;
        Ok(Lease { gate: self })
    }
    /// New writes fail rather than waiting behind a modal operation and landing
    /// after a snapshot the caller believed contained them.
    pub fn writer(&self) -> Result<Writer<'_>, String> {
        self.writer_inner(false)
    }

    fn writer_inner(&self, allow_close: bool) -> Result<Writer<'_>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "The data operation is unavailable.")?;
        let key = self as *const Gate as usize;
        let already_writing = WRITERS_BY_GATE.with(|writers| writers.borrow().contains_key(&key));
        if (state.exclusive || (state.closing && !allow_close)) && !already_writing {
            return Err(
                "An application-data backup or restore is in progress. Try again when it finishes."
                    .into(),
            );
        }
        state.writers = state
            .writers
            .checked_add(1)
            .ok_or("Too many data operations are running.")?;
        WRITERS_BY_GATE.with(|writers| *writers.borrow_mut().entry(key).or_default() += 1);
        Ok(Writer {
            gate: self,
            not_send: std::marker::PhantomData,
        })
    }

    /// Block new writers first, then wait for previously admitted writes.
    pub fn capture(&self, canceled: &AtomicBool) -> Result<Capture<'_>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "The data operation is unavailable.")?;
        if state.exclusive || state.closing {
            return Err("Another application-data operation is already running.".into());
        }
        state.exclusive = true;
        while state.writers > 0 {
            if canceled.load(Ordering::Acquire) {
                state.exclusive = false;
                self.changed.notify_all();
                return Err("The data operation was canceled.".into());
            }
            let result = self
                .changed
                .wait_timeout(state, Duration::from_millis(100))
                .map_err(|_| "The data operation is unavailable.")?;
            state = result.0;
        }
        if canceled.load(Ordering::Acquire) {
            state.exclusive = false;
            self.changed.notify_all();
            return Err("The data operation was canceled.".into());
        }
        Ok(Capture {
            gate: self,
            active: true,
        })
    }
}

impl<'a> Capture<'a> {
    pub fn into_close_barrier(mut self) -> Result<CloseBarrier<'a>, String> {
        let mut state = self
            .gate
            .state
            .lock()
            .map_err(|_| "The data operation is unavailable.")?;
        if !state.exclusive || state.writers != 0 {
            return Err("The restore barrier is unavailable.".into());
        }
        state.exclusive = false;
        state.closing = true;
        self.active = false;
        Ok(CloseBarrier {
            gate: self.gate,
            active: true,
        })
    }
}

impl<'a> CloseBarrier<'a> {
    pub fn capture(mut self, canceled: &AtomicBool) -> Result<Capture<'a>, String> {
        let mut state = self
            .gate
            .state
            .lock()
            .map_err(|_| "The data operation is unavailable.")?;
        if !state.closing || state.exclusive {
            return Err("The restore barrier is unavailable.".into());
        }
        state.closing = false;
        state.exclusive = true;
        self.active = false;
        while state.writers > 0 {
            if canceled.load(Ordering::Acquire) {
                state.exclusive = false;
                self.gate.changed.notify_all();
                return Err("The restore was canceled.".into());
            }
            state = self
                .gate
                .changed
                .wait_timeout(state, Duration::from_millis(100))
                .map_err(|_| "The data operation is unavailable.")?
                .0;
        }
        if canceled.load(Ordering::Acquire) {
            state.exclusive = false;
            self.gate.changed.notify_all();
            return Err("The restore was canceled.".into());
        }
        Ok(Capture {
            gate: self.gate,
            active: true,
        })
    }
}

impl Drop for Lease<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.gate.state.lock() {
            state.writers -= 1;
            self.gate.changed.notify_all();
        }
    }
}

impl Drop for Writer<'_> {
    fn drop(&mut self) {
        let key = self.gate as *const Gate as usize;
        WRITERS_BY_GATE.with(|writers| {
            let mut writers = writers.borrow_mut();
            if let Some(count) = writers.get_mut(&key) {
                *count -= 1;
                if *count == 0 {
                    writers.remove(&key);
                }
            }
        });
        if let Ok(mut state) = self.gate.state.lock() {
            state.writers -= 1;
            self.gate.changed.notify_all();
        }
    }
}

impl Drop for Capture<'_> {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        if let Ok(mut state) = self.gate.state.lock() {
            state.exclusive = false;
            self.gate.changed.notify_all();
        }
    }
}

impl Drop for CloseBarrier<'_> {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        if let Ok(mut state) = self.gate.state.lock() {
            state.closing = false;
            self.gate.changed.notify_all();
        }
    }
}

pub static DATA_GATE: Gate = Gate {
    state: Mutex::new(State {
        exclusive: false,
        closing: false,
        writers: 0,
    }),
    changed: Condvar::new(),
};

pub fn writer() -> Result<Writer<'static>, String> {
    DATA_GATE.writer()
}

/// Operations the normal close guard may need after the safety snapshot.
pub fn close_writer() -> Result<Writer<'static>, String> {
    DATA_GATE.writer_inner(true)
}

pub fn capture(canceled: &AtomicBool) -> Result<Capture<'static>, String> {
    DATA_GATE.capture(canceled)
}

pub fn lease() -> Result<Lease<'static>, String> {
    DATA_GATE.lease()
}

pub fn close_lease() -> Result<Lease<'static>, String> {
    DATA_GATE.lease_inner(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn capture_waits_for_existing_writers_and_rejects_new_ones() {
        let gate = Arc::new(Gate::default());
        let writer = gate.writer().unwrap();
        std::thread::scope(|scope| {
            let copy = gate.clone();
            let handle = scope.spawn(move || {
                let canceled = AtomicBool::new(false);
                let _capture = copy.capture(&canceled).unwrap();
                assert!(copy.writer().is_err());
            });
            while !gate.state.lock().unwrap().exclusive {
                std::thread::yield_now();
            }
            // A writer already in flight can call another guarded operation.
            assert!(gate.writer().is_ok());
            let other = gate.clone();
            assert!(scope.spawn(move || other.writer().is_err()).join().unwrap());
            drop(writer);
            handle.join().unwrap();
        });
        assert!(gate.writer().is_ok());
    }

    #[test]
    fn cancel_waiting_capture_releases_the_gate() {
        let gate = Arc::new(Gate::default());
        let canceled = Arc::new(AtomicBool::new(false));
        let writer = gate.writer().unwrap();
        std::thread::scope(|scope| {
            let copy = gate.clone();
            let stop = canceled.clone();
            let handle = scope.spawn(move || assert!(copy.capture(&stop).is_err()));
            while !gate.state.lock().unwrap().exclusive {
                std::thread::yield_now();
            }
            canceled.store(true, Ordering::Release);
            handle.join().unwrap();
        });
        drop(writer);
        assert!(gate.writer().is_ok());
    }

    #[test]
    fn close_barrier_allows_close_writes_but_not_other_mutations() {
        let gate = Gate::default();
        let canceled = AtomicBool::new(false);
        let barrier = gate
            .capture(&canceled)
            .unwrap()
            .into_close_barrier()
            .unwrap();
        assert!(gate.writer().is_err());
        assert!(gate.lease().is_err());
        drop(gate.writer_inner(true).unwrap());
        drop(gate.lease_inner(true).unwrap());
        let capture = barrier.capture(&canceled).unwrap();
        assert!(gate.writer_inner(true).is_err());
        drop(capture);
        assert!(gate.writer().is_ok());
    }

    #[test]
    fn canceled_close_barrier_releases_the_gate() {
        let gate = Gate::default();
        let canceled = AtomicBool::new(false);
        let barrier = gate
            .capture(&canceled)
            .unwrap()
            .into_close_barrier()
            .unwrap();
        canceled.store(true, Ordering::Release);
        assert!(barrier.capture(&canceled).is_err());
        assert!(gate.writer().is_ok());
    }
}
