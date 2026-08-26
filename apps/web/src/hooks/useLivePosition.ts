// The anti-staleness mechanism, concretely: this hook's state type has NO variant that can be
// populated from archived JSON. "loading" -> "ready" (data + fetchedAt + blockNumber) ->
// "error" (explicit, with retry) -- never a silent fallback to a cached/last-known value.

import { useCallback, useEffect, useState } from "react";
import { fetchLivePositionState, type LivePositionState } from "../chain/liveReads";

export type LivePositionQuery =
  | { status: "loading" }
  | { status: "ready"; data: LivePositionState }
  | { status: "error"; message: string };

export function useLivePosition() {
  const [query, setQuery] = useState<LivePositionQuery>({ status: "loading" });

  const refetch = useCallback(() => {
    setQuery({ status: "loading" });
    fetchLivePositionState()
      .then((data) => setQuery({ status: "ready", data }))
      .catch((err) => setQuery({ status: "error", message: err instanceof Error ? err.message : String(err) }));
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { query, refetch };
}
