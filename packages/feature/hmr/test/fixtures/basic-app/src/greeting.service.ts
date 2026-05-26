import { defineService } from '@justscale/core';
import { state } from './state.js';

export class GreetingService extends defineService({
  inject: {},
  factory: () => ({
    greet(name: string): string {
      state.trail.push(`greet:${name}`);
      return `Hello, ${name}!`;
    },
    bumpCounter(): number {
      state.counter += 1;
      return state.counter;
    },
    snapshot() {
      return { counter: state.counter, trailLength: state.trail.length };
    },
  }),
}) {}
