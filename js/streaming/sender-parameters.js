const queues = new WeakMap();
const statuses = new WeakMap();
const optionalError = error => ['NotSupportedError', 'InvalidModificationError'].includes(error.name);

export const getSenderParameterStatus = sender => statuses.get(sender) || null;

/** Serialize writes and progressively remove optional fields, preserving adaptation. */
export function mutateVideoSender(sender, mutate) {
  const previous = queues.get(sender) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const params = sender.getParameters?.();
      if (!params?.encodings?.length) return false;
      mutate(params);
      const requested = params.degradationPreference ?? statuses.get(sender)?.requestedDegradationPreference ?? null;
      if (attempt >= 1) for (const encoding of params.encodings) delete encoding.networkPriority;
      if (attempt >= 2) for (const encoding of params.encodings) delete encoding.priority;
      if (attempt >= 3) delete params.degradationPreference;
      try {
        await sender.setParameters(params);
        const effective = sender.getParameters?.().degradationPreference ?? null;
        statuses.set(sender, {
          requestedDegradationPreference: requested,
          effectiveDegradationPreference: effective,
          senderParameterFallback: attempt === 3 ? 'degradation-unsupported' : requested && effective !== requested ? 'preference-not-applied' : attempt ? 'priority-only' : null
        });
        if (requested && effective !== requested) console.warn('[WebRTC] Preferência de adaptação não aplicada:', requested, 'efetiva:', effective);
        return true;
      } catch (error) {
        if (!optionalError(error) || attempt === 3) throw error;
      }
    }
    return false;
  });
  queues.set(sender, operation);
  return operation;
}

