import type { Board } from '../core/board';
import { demoBoard } from '../core/demo';

export interface LoadedBoard {
  readonly board: Board;
  readonly live: boolean;
  readonly error: string | null;
}

/** Reads the board from the local server; falls back to the demo so the build works alone. */
export async function loadBoard(): Promise<LoadedBoard> {
  try {
    const response = await fetch('./api/board', { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`board request failed (${response.status})`);
    const board = (await response.json()) as Board;
    return { board, live: true, error: null };
  } catch (error) {
    return {
      board: await demoBoard(),
      live: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
