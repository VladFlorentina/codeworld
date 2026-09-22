import { useCallback, useEffect, useRef, useState } from "react";
import { getJobStatus } from "@/lib/api";
import { JobStatus, JobStatusResponse } from "@/types/city";

export type ActiveJob<TMeta = Record<string, unknown>> = TMeta & {
  jobId: string;
  status: JobStatus;
};

export interface UseJobPollingOptions<TMeta = Record<string, unknown>> {
  intervalMs?: number;
  fetcher?: (jobId: string) => Promise<JobStatusResponse>;
  onStatusChange?: (status: JobStatus, job: JobStatusResponse, meta: TMeta) => void;
  onComplete?: (job: JobStatusResponse, meta: TMeta) => void;
  onFailed?: (error: string, job: JobStatusResponse, meta: TMeta) => void;
  onError?: (error: Error, meta: TMeta) => void;
}

export interface UseJobPollingReturn<TMeta = Record<string, unknown>> {
  activeJob: ActiveJob<TMeta> | null;
  isPolling: boolean;
  startPolling: (jobId: string, initialStatus: JobStatus, meta: TMeta) => void;
  stopPolling: () => void;
  clearActiveJob: () => void;
  setActiveJob: React.Dispatch<React.SetStateAction<ActiveJob<TMeta> | null>>;
}

/**
 * Shared hook for asynchronous job polling across CodeWorld pages.
 *
 * Guarantees:
 * 1. Sequential tick scheduling (max 1 in-flight request at a time; no overlapping requests).
 * 2. Generation token invalidation on startPolling, stopPolling, and unmount.
 *    Stale or delayed in-flight responses are strictly ignored, even if the same jobId is restarted.
 * 3. Terminal states (complete, failed, network error) invoke callbacks exactly once.
 * 4. Safe unmount cleanup without calling setState after unmount.
 */
export function useJobPolling<TMeta = Record<string, unknown>>(
  options: UseJobPollingOptions<TMeta> = {}
): UseJobPollingReturn<TMeta> {
  const [activeJob, setActiveJob] = useState<ActiveJob<TMeta> | null>(null);
  const [isPolling, setIsPolling] = useState<boolean>(false);

  const generationRef = useRef<number>(0);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const currentMetaRef = useRef<TMeta | null>(null);
  const currentJobIdRef = useRef<string | null>(null);

  // Keep latest options in ref to maintain stable hook callbacks without restarting polling
  const optionsRef = useRef<UseJobPollingOptions<TMeta>>(options);
  optionsRef.current = options;

  const stopPolling = useCallback(() => {
    generationRef.current++;
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setIsPolling(false);
  }, []);

  const clearActiveJob = useCallback(() => {
    setActiveJob(null);
  }, []);

  const startPolling = useCallback(
    (jobId: string, initialStatus: JobStatus, meta: TMeta) => {
      // Invalidate any existing polling loop and in-flight responses
      generationRef.current++;
      const gen = generationRef.current;

      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }

      currentJobIdRef.current = jobId;
      currentMetaRef.current = meta;

      setActiveJob({
        ...meta,
        jobId,
        status: initialStatus,
      });
      setIsPolling(true);

      const interval = optionsRef.current.intervalMs ?? 2000;
      const fetchStatus = optionsRef.current.fetcher ?? getJobStatus;

      const pollTick = async () => {
        // Stale check before initiating request
        if (generationRef.current !== gen) return;

        try {
          const jobData = await fetchStatus(jobId);

          // Stale check after response arrives
          if (generationRef.current !== gen) return;

          if (jobData.status === "complete") {
            // Terminal: stop polling and notify
            generationRef.current++;
            if (timeoutRef.current) {
              clearTimeout(timeoutRef.current);
              timeoutRef.current = null;
            }
            setIsPolling(false);

            optionsRef.current.onComplete?.(jobData, meta);
            return;
          }

          if (jobData.status === "failed") {
            // Terminal: stop polling, clear activeJob, and notify
            generationRef.current++;
            if (timeoutRef.current) {
              clearTimeout(timeoutRef.current);
              timeoutRef.current = null;
            }
            setIsPolling(false);
            setActiveJob(null);

            const errorMsg = jobData.error || "Analysis job failed. Please try again.";
            optionsRef.current.onFailed?.(errorMsg, jobData, meta);
            return;
          }

          // Non-terminal state: queued or running
          setActiveJob((prev) => {
            if (!prev || prev.jobId !== jobId) return prev;
            return { ...prev, status: jobData.status };
          });

          optionsRef.current.onStatusChange?.(jobData.status, jobData, meta);

          // Sequential tick: schedule next poll only after current request has completed
          if (generationRef.current === gen) {
            timeoutRef.current = setTimeout(pollTick, interval);
          }
        } catch (err: unknown) {
          if (generationRef.current !== gen) return;

          generationRef.current++;
          if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
          }
          setIsPolling(false);
          setActiveJob(null);

          const error = err instanceof Error ? err : new Error(String(err));
          optionsRef.current.onError?.(error, meta);
        }
      };

      // First tick scheduled after interval
      timeoutRef.current = setTimeout(pollTick, interval);
    },
    []
  );

  useEffect(() => {
    return () => {
      // Unmount cleanup: cancel timer and invalidate generation
      generationRef.current++;
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      // Strictly avoid calling setState on unmount
    };
  }, []);

  return {
    activeJob,
    isPolling,
    startPolling,
    stopPolling,
    clearActiveJob,
    setActiveJob,
  };
}
