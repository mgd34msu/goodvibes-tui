import { logger } from '../utils/logger.ts';

export type InputToken = 
  | { type: 'text', value: string }
  | { type: 'key', name: string, logicalName: string, ctrl: boolean, shift: boolean, meta: boolean }
  | { type: 'mouse', button: number, col: number, row: number, action: 'press' | 'release' }
  | { type: 'focus', action: 'in' | 'out' };

/**
 * InputTokenizer - Optimized for Tmux and CSI-u compatibility.
 */
export class InputTokenizer {
  private buffer = '';
  private isPasting = false;
  private pasteContent = '';

  public feed(data: string): InputToken[] {
    this.buffer += data;
    const tokens: InputToken[] = [];

    if (this.buffer.length > 1024 * 100) { // Increased safety for large pastes
      this.buffer = '';
      return [];
    }

    while (this.buffer.length > 0) {
      // 1. Bracketed Paste Handling
      if (this.buffer.startsWith('\x1b[200~')) {
        this.isPasting = true;
        this.pasteContent = '';
        this.buffer = this.buffer.slice(6);
        continue;
      }
      
      if (this.isPasting) {
        const endIdx = this.buffer.indexOf('\x1b[201~');
        if (endIdx !== -1) {
          this.pasteContent += this.buffer.slice(0, endIdx);
          tokens.push({ type: 'text', value: this.pasteContent });
          this.isPasting = false;
          this.pasteContent = '';
          this.buffer = this.buffer.slice(endIdx + 6);
          continue;
        } else {
          // Still pasting, wait for more data
          this.pasteContent += this.buffer;
          this.buffer = '';
          break;
        }
      }

      // 2. Escape Sequences
      if (this.buffer.startsWith('\x1b')) {
        if (this.buffer.startsWith('\x1b[I')) { tokens.push({ type: 'focus', action: 'in' }); this.buffer = this.buffer.slice(3); continue; }
        if (this.buffer.startsWith('\x1b[O')) { tokens.push({ type: 'focus', action: 'out' }); this.buffer = this.buffer.slice(3); continue; }

        // SS3 function keys: \x1bOP (F1), \x1bOQ (F2), \x1bOR (F3), \x1bOS (F4)
        if (this.buffer.startsWith('\x1bOP')) { tokens.push({ type: 'key', name: '\x1bOP', logicalName: 'f1', ctrl: false, shift: false, meta: false }); this.buffer = this.buffer.slice(3); continue; }
        if (this.buffer.startsWith('\x1bOQ')) { tokens.push({ type: 'key', name: '\x1bOQ', logicalName: 'f2', ctrl: false, shift: false, meta: false }); this.buffer = this.buffer.slice(3); continue; }
        if (this.buffer.startsWith('\x1bOR')) { tokens.push({ type: 'key', name: '\x1bOR', logicalName: 'f3', ctrl: false, shift: false, meta: false }); this.buffer = this.buffer.slice(3); continue; }
        if (this.buffer.startsWith('\x1bOS')) { tokens.push({ type: 'key', name: '\x1bOS', logicalName: 'f4', ctrl: false, shift: false, meta: false }); this.buffer = this.buffer.slice(3); continue; }

        const mouseMatch = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(this.buffer);
        if (mouseMatch) {
          tokens.push({
            type: 'mouse', button: parseInt(mouseMatch[1], 10),
            col: parseInt(mouseMatch[2], 10) - 1, row: parseInt(mouseMatch[3], 10) - 1,
            action: mouseMatch[4] === 'M' ? 'press' : 'release'
          });
          this.buffer = this.buffer.slice(mouseMatch[0].length);
          continue;
        }

        const seqMatch = /^\x1b\[([0-9;?<>:]*)([a-zA-Z~])/.exec(this.buffer);
        if (seqMatch) {
          const full = seqMatch[0];
          const params = seqMatch[1];
          const suffix = seqMatch[2];
          const parts = params.split(/[;:]/);
          let charCode = parseInt(parts[0] || '0', 10);
          let modValue = parseInt(parts[1] || '1', 10);
          if (params.startsWith('27;') && suffix === '~') {
            modValue = parseInt(parts[1] || '1', 10);
            charCode = parseInt(parts[2] || '0', 10);
          }
          const shift = (modValue - 1 & 1) !== 0;
          const meta  = (modValue - 1 & 2) !== 0;
          const ctrl  = (modValue - 1 & 4) !== 0;
          let logicalName = full;
          if (charCode === 13 || charCode === 10) logicalName = 'enter';
          if (charCode === 99 || charCode === 67 || charCode === 3) logicalName = 'c';
          if (suffix === 'A') logicalName = 'up';
          if (suffix === 'B') logicalName = 'down';
          if (suffix === 'C') logicalName = 'right';
          if (suffix === 'D') logicalName = 'left';
          if (suffix === 'H') logicalName = 'home';
          if (suffix === 'F') logicalName = 'end';
          if (suffix === '~' && charCode === 5) logicalName = 'pageup';
          if (suffix === '~' && charCode === 6) logicalName = 'pagedown';
          if (suffix === '~' && charCode === 3) logicalName = 'delete';
          if (suffix === '~' && charCode === 2) logicalName = 'insert';
          if (suffix === '~' && charCode === 11) logicalName = 'f1';
          if (suffix === '~' && charCode === 12) logicalName = 'f2';
          if (suffix === '~' && charCode === 13) logicalName = 'f3';
          if (suffix === '~' && charCode === 14) logicalName = 'f4';
          if (suffix === '~' && charCode === 15) logicalName = 'f5';
          if (suffix === '~' && charCode === 17) logicalName = 'f6';
          if (suffix === '~' && charCode === 18) logicalName = 'f7';
          if (suffix === '~' && charCode === 19) logicalName = 'f8';
          if (suffix === '~' && charCode === 20) logicalName = 'f9';
          if (suffix === '~' && charCode === 21) logicalName = 'f10';
          if (suffix === '~' && charCode === 23) logicalName = 'f11';
          if (suffix === '~' && charCode === 24) logicalName = 'f12';
          if (charCode === 9) logicalName = 'tab';
          if (charCode === 27) logicalName = 'escape';
          if (charCode === 127) logicalName = 'backspace';
          // CSI u: map printable ASCII charCodes to their lowercase letter name
          if (logicalName === full && charCode >= 97 && charCode <= 122) logicalName = String.fromCharCode(charCode);
          if (logicalName === full && charCode >= 65 && charCode <= 90) logicalName = String.fromCharCode(charCode + 32);
          tokens.push({ type: 'key', name: full, logicalName, ctrl, shift, meta });
          this.buffer = this.buffer.slice(full.length);
          continue;
        }
        
        // Bare escape key (not followed by [)
        if (this.buffer.length === 1 || !this.buffer.startsWith('\x1b[')) {
          tokens.push({ type: 'key', name: '\x1b', logicalName: 'escape', ctrl: false, shift: false, meta: false });
          this.buffer = this.buffer.slice(1);
          continue;
        }
        break; 
      } else {
        const char = this.buffer[0];
        const code = char.charCodeAt(0);
        let logicalName = char;
        let isCtrl = false;
        let isShift = false;
        if (code === 3) { logicalName = 'c'; isCtrl = true; }
        else if (code === 13) { logicalName = 'enter'; }
        else if (code === 10) { logicalName = 'enter'; isShift = true; }
        else if (code === 127 || code === 8) { logicalName = 'backspace'; }
        else if (code === 9) { logicalName = 'tab'; }
        else if (code < 32) {
           logicalName = String.fromCharCode(code + 96).toLowerCase(); 
           isCtrl = true;
        }
        if (code < 32 || code === 127) {
          tokens.push({ type: 'key', name: char, logicalName, ctrl: isCtrl, shift: isShift, meta: false });
        } else {
          tokens.push({ type: 'text', value: char });
        }
        this.buffer = this.buffer.slice(1);
      }
    }
    return tokens;
  }
}
