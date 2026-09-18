export const CLOCK = Symbol('Clock');

/** Steps sao puros; quem precisa de tempo recebe esta porta e fica testavel. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
