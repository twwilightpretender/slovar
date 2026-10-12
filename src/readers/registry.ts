import type { Format } from './types';
import { dsl } from './dsl';
import { gls } from './gls';
import { mdx } from './mdx';
import { slob } from './slob';
import { stardict } from './stardict';

/** Форматы, для которых читалка уже есть. Остальные (BGL) показываются как «скоро». */
export const FORMATS: Record<string, Format> = { mdx, dsl, stardict, slob, gls };
