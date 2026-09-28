import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Observable } from 'rxjs';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

@Injectable()
export class AnalyticsEventsService {
  constructor(private readonly eventEmitter: EventEmitter2) {}

  stream(publicKey: string): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      const listener = (eventName: string, payload: unknown) => {
        if (!isRecord(payload)) return;

        const eventPublicKey = payload.recipientPublicKey ?? payload.publicKey ?? payload.owner;
        if (eventPublicKey !== publicKey) return;

        subscriber.next({
          type: 'analytics.updated',
          data: JSON.stringify({
            eventType: eventName,
            eventId: payload.eventId ?? null,
            occurredAt: new Date().toISOString(),
          }),
        });
      };

      this.eventEmitter.onAny(listener);
      const heartbeat = setInterval(() => {
        subscriber.next({ type: 'analytics.heartbeat', data: '{}' });
      }, 30_000);

      return () => {
        this.eventEmitter.offAny(listener);
        clearInterval(heartbeat);
      };
    });
  }
}
