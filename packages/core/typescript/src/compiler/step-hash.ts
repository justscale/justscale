/**
 * @justscale/core/process - Step Hash Computation
 *
 * Computes stable hashes for process steps to enable:
 * 1. Persistence stability (code changes don't break suspended processes)
 * 2. Version migration detection
 * 3. Debugging/tracing
 *
 * Hash inputs:
 * - Step type (entry, resume, branch)
 * - Signal/timer being waited on (for resume steps)
 * - Suspension index within the function
 * - Control flow context
 */

import { createHash } from 'crypto';
import type { AnalysisResult } from './analyzer.js';

export interface StepHashInput {
  type: 'entry' | 'block' | 'resume' | 'branch'
  opcodeRange: { start: number; end: number }
  index: number
}

/**
 * Compute a stable hash for a step.
 *
 * The hash is based on:
 * 1. Step type
 * 2. Signal/timer identity (for suspension points)
 * 3. Step index as tiebreaker
 *
 * This means:
 * - Adding console.log doesn't change the hash (no new suspension)
 * - Renaming variables doesn't change the hash (not part of identity)
 * - Adding a new suspension point DOES change subsequent hashes
 */
export function computeStepHash(
  input: StepHashInput,
  analysis: AnalysisResult,
  opcodeStart: number
): string {
  const { type, index } = input;
  const { opcodes } = analysis;

  // Build hash input string
  const parts: string[] = [type];

  // For resume/branch steps, include the signal/timer being waited on
  if (type === 'resume' && opcodeStart > 0) {
    const waitOp = opcodes[opcodeStart - 1];
    if (waitOp.op === 'WAIT') {
      parts.push(`signal:${waitOp.signal}`);
    }
  }

  if (type === 'branch') {
    // Find the race branch this step handles
    for (let i = 0; i < opcodeStart; i++) {
      const op = opcodes[i];
      if (op.op === 'RACE_START') {
        for (const branch of op.branches) {
          if (branch.jumpTarget === opcodeStart) {
            if (branch.signal) {
              parts.push(`race-signal:${branch.signal}`);
            } else if (branch.timer) {
              // Serialize timer without the AST node - just unit and expression text
              const timerInfo = `${branch.timer.unit}:${branch.timer.valueExpr.getText()}`;
              parts.push(`race-timer:${timerInfo}`);
            }
            break;
          }
        }
      }
    }
  }

  // Include index as tiebreaker for uniqueness
  parts.push(`idx:${index}`);

  // Compute hash
  const hashInput = parts.join('|');
  const hash = createHash('sha256').update(hashInput).digest('hex').slice(0, 8);

  // Return formatted hash with type prefix
  return `${type}_${hash}`;
}

/**
 * Compute a version hash for the entire process.
 * Used to detect if the process structure has changed.
 */
export function computeVersionHash(analysis: AnalysisResult): string {
  const structure = JSON.stringify({
    opcodes: analysis.opcodes.map(op => op.op),
    signals: Object.keys(analysis.signals).sort(),
    rehydration: Object.keys(analysis.rehydrationBlocks).sort(),
  });

  const hash = createHash('sha256').update(structure).digest('hex').slice(0, 8);
  return `v_${hash}`;
}
