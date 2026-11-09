// Minimal typings for gcode-parser@2 (CommonJS), covering the parseLine() call the controller
// makes (src/server/controller/filters.ts).
declare module 'gcode-parser' {
  export interface ParseLineOptions {
    /** true: words as 'G1' strings (letter + Number(argument)); false: ['G', 1] pairs. */
    flatten?: boolean;
    /** 'original' (default) keeps the line, 'stripped' removes comments, 'compact' also removes whitespace. */
    lineMode?: 'original' | 'stripped' | 'compact';
  }

  export interface ParseLineResult<Word> {
    line: string;
    words: Word[];
    /** N line number. */
    ln?: number;
    /** * checksum. */
    cs?: number;
    /** Set when the checksum does not match. */
    err?: boolean;
    /** `%…`, `{…}` and `$…` commands. */
    cmds?: string[];
    comments?: string[];
  }

  export function parseLine(line: string, options: ParseLineOptions & { flatten: true }): ParseLineResult<string>;
  export function parseLine(line: string, options?: ParseLineOptions): ParseLineResult<[string, number | string]>;
}
