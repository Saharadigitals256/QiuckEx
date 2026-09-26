import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  getOfflineQueue,
  saveOfflineQueue,
  enqueueAction,
  dequeueAction,
  clearOfflineQueue,
  updateQueueItem,
  retryQueuedAction,
  processOfflineQueue,
  registerActionHandler,
  cancelQueuedAction,
} from "../services/offline-queue";

jest.mock("@react-native-async-storage/async-storage", () => {
  let store: Record<string, string> = {};
  return {
    getItem: jest.fn(async (key) => store[key] ?? null),
    setItem: jest.fn(async (key, value) => {
      store[key] = value;
    }),
    removeItem: jest.fn(async (key) => {
      delete store[key];
    }),
    clear: jest.fn(async () => {
      store = {};
    }),
  };
});

describe("Offline Action Queue Service", () => {
  const SUCCESS_ACTION = "test.success";
  const FAILURE_ACTION = "test.failure";

  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    registerActionHandler(SUCCESS_ACTION, async () => undefined);
    registerActionHandler(FAILURE_ACTION, async () => {
      throw new Error("Test handler failure");
    });
  });

  it("should start with an empty queue", async () => {
    const queue = await getOfflineQueue();
    expect(queue).toEqual([]);
  });

  it("should enqueue a new action and mark it as pending", async () => {
    const action = await enqueueAction(SUCCESS_ACTION, { key: "value" });
    expect(action.id).toBeDefined();
    expect(action.type).toBe(SUCCESS_ACTION);
    expect(action.payload).toEqual({ key: "value" });
    expect(action.status).toBe("pending");
    expect(action.attempts).toBe(0);
    expect(action.failureReason).toBeNull();
    expect(action.timestamp).toBeLessThanOrEqual(Date.now());

    const queue = await getOfflineQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toEqual(action);
  });

  it("should dequeue an action by ID", async () => {
    const action1 = await enqueueAction(SUCCESS_ACTION, { id: 1 });
    const action2 = await enqueueAction(FAILURE_ACTION, { id: 2 });

    let queue = await getOfflineQueue();
    expect(queue).toHaveLength(2);

    await dequeueAction(action1.id);
    queue = await getOfflineQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].id).toBe(action2.id);
  });

  it("should clear the entire queue", async () => {
    await enqueueAction(SUCCESS_ACTION, { id: 1 });
    await enqueueAction(FAILURE_ACTION, { id: 2 });

    let queue = await getOfflineQueue();
    expect(queue).toHaveLength(2);

    await clearOfflineQueue();
    queue = await getOfflineQueue();
    expect(queue).toHaveLength(0);
  });

  it("should update metadata fields on a queue item", async () => {
    const action = await enqueueAction(SUCCESS_ACTION, { foo: "bar" });
    const updated = await updateQueueItem(action.id, {
      status: "failed",
      attempts: 3,
      failureReason: "Timed out",
    });

    expect(updated).not.toBeNull();
    expect(updated?.status).toBe("failed");
    expect(updated?.attempts).toBe(3);
    expect(updated?.failureReason).toBe("Timed out");

    const queue = await getOfflineQueue();
    expect(queue[0].status).toBe("failed");
  });

  it("should process a registered action successfully", async () => {
    const action = await enqueueAction(SUCCESS_ACTION, { foo: "bar" });
    const result = await retryQueuedAction(action.id);

    expect(result?.status).toBe("completed");
    expect(result?.attempts).toBe(1);
    expect(result?.failureReason).toBeNull();
  });

  it("should record failure reasons when a registered action fails", async () => {
    const action = await enqueueAction(FAILURE_ACTION, { foo: "bar" });
    const result = await retryQueuedAction(action.id);

    expect(result?.status).toBe("failed");
    expect(result?.attempts).toBe(1);
    expect(result?.failureReason).toBe("Test handler failure");
  });

  it("should process all pending and failed actions sequentially", async () => {
    const act1 = await enqueueAction(SUCCESS_ACTION, { number: 1 });
    const act2 = await enqueueAction(FAILURE_ACTION, { number: 2 });
    const act3 = await enqueueAction(SUCCESS_ACTION, { number: 3 });

    // Mark act3 as completed manually first so it's skipped
    await updateQueueItem(act3.id, { status: "completed" });

    await processOfflineQueue();

    const queue = await getOfflineQueue();
    const statusMap = new Map(queue.map((item) => [item.id, item]));

    expect(statusMap.get(act1.id)?.status).toBe("completed");
    expect(statusMap.get(act2.id)?.status).toBe("failed");
    expect(statusMap.get(act3.id)?.status).toBe("completed"); // Unaffected by retry run because it was completed
    expect(statusMap.get(act1.id)?.attempts).toBe(1);
    expect(statusMap.get(act2.id)?.attempts).toBe(1);
    expect(statusMap.get(act3.id)?.attempts).toBe(0);
  });

  describe("Idempotency deduplication", () => {
    it("deduplicates action when idempotencyKey is already pending or completed", async () => {
      const first = await enqueueAction(SUCCESS_ACTION, { msg: "hello" }, {
        idempotencyKey: "unique-key-1",
      });

      const second = await enqueueAction(SUCCESS_ACTION, { msg: "hello again" }, {
        idempotencyKey: "unique-key-1",
      });

      expect(second.id).toBe(first.id);
      const queue = await getOfflineQueue();
      expect(queue).toHaveLength(1);

      // Now complete it
      await retryQueuedAction(first.id);

      // Enqueueing again with same key returns existing completed action
      const third = await enqueueAction(SUCCESS_ACTION, { msg: "third" }, {
        idempotencyKey: "unique-key-1",
      });
      expect(third.id).toBe(first.id);
      expect(third.status).toBe("completed");
    });
  });

  describe("Dependency ordering", () => {
    it("waits for predecessor dependency to complete before executing dependent action", async () => {
      const step1 = await enqueueAction(SUCCESS_ACTION, { step: 1 }, {
        idempotencyKey: "step-1",
      });
      const step2 = await enqueueAction(SUCCESS_ACTION, { step: 2 }, {
        dependsOn: ["step-1"],
      });

      // Retrying step2 directly while step1 is pending is deferred
      const directRetry = await retryQueuedAction(step2.id);
      expect(directRetry?.status).toBe("pending");
      expect(directRetry?.attempts).toBe(0);

      // Run processOfflineQueue which resolves in dependency order
      await processOfflineQueue();

      const queue = await getOfflineQueue();
      const s1 = queue.find((i) => i.id === step1.id);
      const s2 = queue.find((i) => i.id === step2.id);

      expect(s1?.status).toBe("completed");
      expect(s2?.status).toBe("completed");
      expect(s2?.attempts).toBe(1);
    });

    it("fails dependent action if its dependency fails", async () => {
      const failedDep = await enqueueAction(FAILURE_ACTION, { fail: true }, {
        idempotencyKey: "failed-dep-1",
      });
      const dependent = await enqueueAction(SUCCESS_ACTION, { run: false }, {
        dependsOn: ["failed-dep-1"],
      });

      // Process queue - first action will fail, second action should cascade fail
      await processOfflineQueue();

      const queue = await getOfflineQueue();
      const dep = queue.find((i) => i.id === dependent.id);
      expect(dep?.status).toBe("failed");
      expect(dep?.failureReason).toContain("failed");
    });
  });

  describe("Dead letter & Cancellation", () => {
    it("transitions to dead_letter after maxAttempts exceeded", async () => {
      const action = await enqueueAction(FAILURE_ACTION, { max: true }, {
        maxAttempts: 2,
      });

      // Attempt 1
      await retryQueuedAction(action.id);
      let item = (await getOfflineQueue()).find((i) => i.id === action.id);
      expect(item?.status).toBe("failed");
      expect(item?.attempts).toBe(1);

      // Attempt 2 (reaches maxAttempts, force retry bypassing backoff delay)
      await retryQueuedAction(action.id, true);
      item = (await getOfflineQueue()).find((i) => i.id === action.id);
      expect(item?.status).toBe("dead_letter");
      expect(item?.attempts).toBe(2);
      expect(item?.failureReason).toContain("Max retry attempts");
    });

    it("cancels an action and cascades cancellation to dependent actions", async () => {
      const actA = await enqueueAction(SUCCESS_ACTION, { a: 1 });
      const actB = await enqueueAction(SUCCESS_ACTION, { b: 2 }, {
        dependsOn: [actA.id],
      });

      await cancelQueuedAction(actA.id, true);

      const queue = await getOfflineQueue();
      const itemA = queue.find((i) => i.id === actA.id);
      const itemB = queue.find((i) => i.id === actB.id);

      expect(itemA?.status).toBe("failed");
      expect(itemA?.failureReason).toContain("Cancelled");
      expect(itemB?.status).toBe("failed");
      expect(itemB?.failureReason).toContain("Cancelled");
    });
  });
});
