//! The one piece of thread plumbing the rest of the tool shares.
//!
//! Extraction is a chain of passes over lists — files, call sites, methods —
//! where each element is independent of the others and only the merge at the
//! end has to agree with what a single-threaded run would have produced. That
//! is one function, and it lives here so the passes can stay about Rust.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

/// How many chunks to cut a list into, per core.
///
/// Several rather than one, because chunks are claimed as workers free up and
/// a worker that draws a cheap chunk comes back for another. One source file
/// can be a hundred times the size of another — the `windows` crate has a
/// 3.5 MB one — and a fixed deal leaves most of the machine waiting on it.
const CHUNKS_PER_CORE: usize = 8;

pub fn cores() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
}

/// Cuts `items` into contiguous chunks, several per core.
///
/// Contiguous rather than round-robin so that merging results back in chunk
/// order reproduces the order a single-threaded pass would have seen, which
/// is what keeps "the first definition of this name wins" answering the same
/// way on every run and on every machine.
pub fn chunks<T>(items: &[T], wanted: usize) -> Vec<&[T]> {
    if items.is_empty() {
        return Vec::new();
    }
    let wanted = wanted.min(items.len()).max(1);
    items.chunks(items.len().div_ceil(wanted)).collect()
}

/// Runs `work` over the chunks of `items` on every core, and hands the
/// results back **in chunk order** so the caller's merge stays deterministic.
///
/// A chunk whose worker panicked is dropped rather than poisoning the run: a
/// diagram missing one file's worth of edges beats no diagram at all.
pub fn map_chunks<T, R, F>(items: &[T], work: F) -> Vec<R>
where
    T: Sync,
    R: Send,
    F: Fn(&[T]) -> R + Sync,
{
    let shares = chunks(items, cores() * CHUNKS_PER_CORE);
    if shares.len() <= 1 {
        return shares.into_iter().map(&work).collect();
    }

    let out: Vec<Mutex<Option<R>>> = shares.iter().map(|_| Mutex::new(None)).collect();
    let next = AtomicUsize::new(0);
    let workers = cores().min(shares.len());

    std::thread::scope(|threads| {
        for _ in 0..workers {
            let (shares, out, next, work) = (&shares, &out, &next, &work);
            threads.spawn(move || loop {
                let taken = next.fetch_add(1, Ordering::Relaxed);
                let Some(share) = shares.get(taken) else {
                    break;
                };
                let done = work(share);
                if let Some(Ok(mut held)) = out.get(taken).map(Mutex::lock) {
                    *held = Some(done);
                }
            });
        }
    });

    out.into_iter()
        .filter_map(|slot| slot.into_inner().ok().flatten())
        .collect()
}
