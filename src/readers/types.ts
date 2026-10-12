import type { Source } from '../core/protocol';

export interface Reader {
  title: string;
  /** Язык заголовков, если словарь его сообщает (DSL: #INDEX_LANGUAGE). */
  lang?: string;
  headwords: string[];
  /** Для форм слова (синонимы StarDict): номер главного заголовка. Нет — каждая запись сама по себе. */
  canon?: Uint32Array;
  /** Идентификатор статьи в хранилище (смещение): записи с одним номером — одна и та же статья; по нему же статьи читаются подряд. Нужен для текстового поиска. */
  bodyId?(i: number): number;
  /** Чистый текст статьи без разметки (быстрее, чем read + очистка HTML). */
  text?(i: number): Promise<string>;
  /** Включить/выключить режим просмотра всех статей подряд (читать файл крупными кусками). */
  scan?(on: boolean): void;
  /** HTML (или текст) статьи по номеру заголовка. */
  read(i: number): Promise<string>;
  /** Ресурс статьи (css, картинка, звук) из контейнера словаря: MDD, ZIP, Slob. null — такого нет. */
  resource?(name: string): Promise<{ mime: string; data: Uint8Array } | null>;
}

export interface Format {
  id: string;
  /** cached — то, что open вернул в прошлый раз для того же файла (может быть undefined). */
  open(
    src: Source,
    cached: unknown,
    onProgress: (done: number, total: number) => void,
  ): Promise<{ reader: Reader; cache: unknown }>;
}

export class Unsupported extends Error {}
