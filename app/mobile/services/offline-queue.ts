import AsyncStorage from "@react-native-async-storage/async-storage";

export type QueueActionStatus =
  | "pending"
  | "retrying"
  | "failed"
  | "completed"
  | "dead_letter";

export interface QueuedAction<T = any> {
  id: string;
  type: string;
  payload: T;
  timestamp: number;
  status: QueueActionStatus;
  failureReason?: string | null;
  attempts: number;
  maxAttempts?: number;
  idempotencyKey?: string;
  dependsOn?: string[];
  nextRetryAt?: number;
}

export interface EnqueueOptions {
  idempotencyKey?: string;
  dependsOn?: string[];
  maxAttempts?: number;
}

export interface QueueTelemetry {
  event:
    | "enqueue"
    | "process"
    | "retry"
    | "complete"
    | "fail"
    | "dead_letter"
    | "deduplicate"
    | "blocked"
    | "cancel";
  actionId?: string;
  type?: string;
  idempotencyKey?: string;
  attempts?: number;
  error?: string;
  dependsOn?: string[];
}

export function recordQueueTelemetry(telemetry: QueueTelemetry): void {
  if (__DEV__) {
    console.log("[OfflineQueue]", JSON.stringify(telemetry));
  }
}

const OFFLINE_QUEUE_KEY = "quickex.offline-queue.v1";
const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Retrieves all queued actions from local storage.
 */
export async function getOfflineQueue(): Promise<QueuedAction[]> {
  try {
    const raw = await AsyncStorage.getItem(OFFLINE_QUEUE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as QueuedAction[];
  } catch (error) {
    console.error("Failed to load offline queue", error);
    return [];
  }
}

/**
 * Saves the entire queue array to local storage.
 */
export async function saveOfflineQueue(queue: QueuedAction[]): Promise<void> {
  try {
    await AsyncStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
  } catch (error) {
    console.error("Failed to save offline queue", error);
  }
}

/**
 * Enqueues a new offline action with idempotency deduplication and dependency support.
 */
export async function enqueueAction<T = any>(
  type: string,
  payload: T,
  options?: EnqueueOptions,
): Promise<QueuedAction<T>> {
  const queue = await getOfflineQueue();

  if (options?.idempotencyKey) {
    const existing = queue.find(
      (item) => item.idempotencyKey === options.idempotencyKey,
    );
    if (existing) {
      if (
        existing.status === "pending" ||
        existing.status === "retrying" ||
        existing.status === "completed"
      ) {
        recordQueueTelemetry({
          event: "deduplicate",
          actionId: existing.id,
          type: existing.type,
          idempotencyKey: options.idempotencyKey,
          attempts: existing.attempts,
        });
        return existing as QueuedAction<T>;
      }
    }
  }

  const newAction: QueuedAction<T> = {
    id: `act_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
    type,
    payload,
    timestamp: Date.now(),
    status: "pending",
    attempts: 0,
    maxAttempts: options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    failureReason: null,
    idempotencyKey: options?.idempotencyKey,
    dependsOn: options?.dependsOn?.filter(Boolean) ?? [],
  };

  queue.push(newAction);
  await saveOfflineQueue(queue);

  recordQueueTelemetry({
    event: "enqueue",
    actionId: newAction.id,
    type: newAction.type,
    idempotencyKey: newAction.idempotencyKey,
    dependsOn: newAction.dependsOn,
  });

  return newAction;
}

/**
 * Dequeues (removes) a specific action by ID from the queue.
 */
export async function dequeueAction(id: string): Promise<void> {
  const queue = await getOfflineQueue();
  const nextQueue = queue.filter((item) => item.id !== id);
  await saveOfflineQueue(nextQueue);
}

/**
 * Wipes the entire offline queue.
 */
export async function clearOfflineQueue(): Promise<void> {
  try {
    await AsyncStorage.removeItem(OFFLINE_QUEUE_KEY);
  } catch (error) {
    console.error("Failed to clear offline queue", error);
  }
}

/**
 * Updates a queue item's metadata and writes to storage.
 */
export async function updateQueueItem(
  id: string,
  updates: Partial<Omit<QueuedAction, "id">>,
): Promise<QueuedAction | null> {
  const queue = await getOfflineQueue();
  let updatedItem: QueuedAction | null = null;
  const nextQueue = queue.map((item) => {
    if (item.id === id) {
      updatedItem = { ...item, ...updates };
      return updatedItem;
    }
    return item;
  });
  if (updatedItem) {
    await saveOfflineQueue(nextQueue);
  }
  return updatedItem;
}

// ── Handler Registry ─────────────────────────────────────────────────────────

export type ActionHandler<T = any> = (payload: T) => Promise<void>;
const handlers: Record<string, ActionHandler> = {};

export function registerActionHandler<T = any>(
  type: string,
  handler: ActionHandler<T>,
): void {
  handlers[type] = handler;
}

/**
 * Resolves/executes the target action logic based on type.
 */
export async function executeAction(action: QueuedAction): Promise<void> {
  const handler = handlers[action.type];
  if (handler) {
    await handler(action.payload);
    return;
  }

  throw new Error(`No handler registered for action type: ${action.type}`);
}

// ── Dependency Resolution ───────────────────────────────────────────────────

export function checkActionDependencies(
  action: QueuedAction,
  queue: QueuedAction[],
): { canExecute: boolean; blockedReason?: string; dependencyFailed?: boolean } {
  if (!action.dependsOn || action.dependsOn.length === 0) {
    return { canExecute: true };
  }

  for (const depRef of action.dependsOn) {
    const depAction = queue.find(
      (item) => item.id === depRef || item.idempotencyKey === depRef,
    );

    if (!depAction) {
      // If dependency is not in queue, consider it satisfied (e.g. already evicted)
      continue;
    }

    if (depAction.status === "completed") {
      continue;
    }

    if (depAction.status === "failed" || depAction.status === "dead_letter") {
      return {
        canExecute: false,
        dependencyFailed: true,
        blockedReason: `Dependency '${depRef}' failed: ${depAction.failureReason ?? "failure"}`,
      };
    }

    // Still pending or retrying
    return {
      canExecute: false,
      dependencyFailed: false,
      blockedReason: `Waiting on dependency '${depRef}' (status: ${depAction.status})`,
    };
  }

  return { canExecute: true };
}

// ── Retry & Replay ───────────────────────────────────────────────────────────

/**
 * Retries a specific queued action, checking dependencies, idempotency, and retry limits.
 */
export async function retryQueuedAction(
  id: string,
  force = false,
): Promise<QueuedAction | null> {
  const queue = await getOfflineQueue();
  const action = queue.find((item) => item.id === id);
  if (!action) return null;

  // Check dependencies
  const depCheck = checkActionDependencies(action, queue);
  if (!depCheck.canExecute) {
    if (depCheck.dependencyFailed) {
      recordQueueTelemetry({
        event: "fail",
        actionId: id,
        type: action.type,
        error: depCheck.blockedReason,
      });
      return updateQueueItem(id, {
        status: "failed",
        failureReason: depCheck.blockedReason,
      });
    }

    recordQueueTelemetry({
      event: "blocked",
      actionId: id,
      type: action.type,
      error: depCheck.blockedReason,
      dependsOn: action.dependsOn,
    });
    return action;
  }

  // Check exponential backoff timestamp unless forced
  if (!force && action.nextRetryAt && Date.now() < action.nextRetryAt) {
    return action;
  }

  const maxAttempts = action.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (action.attempts >= maxAttempts) {
    recordQueueTelemetry({
      event: "dead_letter",
      actionId: id,
      type: action.type,
      attempts: action.attempts,
      error: "Max attempts exceeded",
    });
    return updateQueueItem(id, {
      status: "dead_letter",
      failureReason: `Max retry attempts (${maxAttempts}) exceeded`,
    });
  }

  await updateQueueItem(id, { status: "retrying", failureReason: null });

  try {
    await executeAction(action);
    const updated = await updateQueueItem(id, {
      status: "completed",
      attempts: action.attempts + 1,
      failureReason: null,
      nextRetryAt: undefined,
    });
    recordQueueTelemetry({
      event: "complete",
      actionId: id,
      type: action.type,
      attempts: action.attempts + 1,
    });
    return updated;
  } catch (error: any) {
    const nextAttempts = action.attempts + 1;
    const isDeadLetter = nextAttempts >= maxAttempts;
    const reason = error?.message || "Unknown error occurred";
    const delayMs = Math.min(60000, Math.pow(2, action.attempts) * 1000);
    const failureReason = isDeadLetter
      ? `Max retry attempts (${maxAttempts}) exceeded: ${reason}`
      : reason;

    const updated = await updateQueueItem(id, {
      status: isDeadLetter ? "dead_letter" : "failed",
      attempts: nextAttempts,
      failureReason,
      nextRetryAt: isDeadLetter ? undefined : Date.now() + delayMs,
    });

    recordQueueTelemetry({
      event: isDeadLetter ? "dead_letter" : "fail",
      actionId: id,
      type: action.type,
      attempts: nextAttempts,
      error: failureReason,
    });
    return updated;
  }
}

/**
 * Cancels a queued action and optionally cascades cancellation to dependents.
 */
export async function cancelQueuedAction(
  id: string,
  cascade = true,
): Promise<void> {
  const queue = await getOfflineQueue();
  const target = queue.find((item) => item.id === id);
  if (!target) return;

  await updateQueueItem(id, {
    status: "failed",
    failureReason: "Cancelled by user or rollback policy",
  });

  recordQueueTelemetry({
    event: "cancel",
    actionId: id,
    type: target.type,
  });

  if (cascade) {
    for (const item of queue) {
      if (item.dependsOn?.includes(id) || (target.idempotencyKey && item.dependsOn?.includes(target.idempotencyKey))) {
        await cancelQueuedAction(item.id, true);
      }
    }
  }
}

/**
 * Processes the offline queue sequentially respecting dependency ordering.
 * Runs multiple rounds so newly unblocked dependent actions execute in the same replay cycle.
 */
export async function processOfflineQueue(): Promise<void> {
  let progress = true;
  let iterations = 0;
  const maxIterations = 20;

  while (progress && iterations < maxIterations) {
    iterations++;
    progress = false;

    const queue = await getOfflineQueue();
    const executableItems = queue.filter(
      (item) => item.status === "pending" || item.status === "failed",
    );

    if (executableItems.length === 0) break;

    for (const item of executableItems) {
      const currentQueue = await getOfflineQueue();
      const depCheck = checkActionDependencies(item, currentQueue);
      if (depCheck.canExecute || depCheck.dependencyFailed) {
        const result = await retryQueuedAction(item.id);
        if (result && result.status !== item.status) {
          progress = true;
        }
      }
    }
  }
}
