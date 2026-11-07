// Provider: replay from cache only. Any cache miss is a clear, actionable error.
export const name = 'offline';

export function info() {
  return { available: true, reason: 'только воспроизведение из кэша data/cache/eval (новые вызовы модели невозможны)' };
}

export async function complete({ model }, _cfg, ctx = {}) {
  const ids = (ctx.criteria || []).map((c) => c.id).join(', ');
  throw new Error(`Офлайн-режим: в кэше нет результата для диалога ${ctx.conversationId || '?'} (критерии: ${ids || '?'}, модель ${model}). Запустите оценку с доступной моделью или импортируйте кэш.`);
}
