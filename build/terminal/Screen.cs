using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace Zhiyu.Terminal {
    // 环形缓冲避免高频输出时逐行移动整个历史数组。
    public sealed class ScrollbackBuffer {
        Cell[][] data;
        int head, count;
        public long TotalAdded { get; private set; }
        public int Count { get { return count; } }
        public ScrollbackBuffer(int capacity) { data = new Cell[capacity][]; }
        public Cell[] this[int index] { get { if (index < 0 || index >= count) throw new ArgumentOutOfRangeException("index"); return data[(head + index) % data.Length]; } }
        public void Add(Cell[] line) { if (count < data.Length) data[(head + count++) % data.Length] = line; else { data[head] = line; head = (head + 1) % data.Length; } TotalAdded++; }
        public void Clear() { Array.Clear(data, 0, data.Length); head = count = 0; }
        public void SetLimit(int capacity) {
            capacity = Math.Max(4, Math.Min(20000, capacity)); if (capacity == data.Length) return;
            int retained = Math.Min(count, capacity); var next = new Cell[capacity][];
            for (int i = 0; i < retained; i++) next[i] = this[count - retained + i];
            data = next; head = 0; count = retained;
        }
    }
    public sealed class HistoryViewport {
        public int Offset { get; private set; }
        public bool Locked { get; private set; }
        public long Unread { get; private set; }
        public void Output(long added, int historyCount) { if (Locked || Offset > 0) { Offset = (int)System.Math.Min(historyCount, (long)Offset + added); Unread += added; } else Offset = 0; }
        public void Scroll(int offset, int historyCount) { Offset = Math.Max(0, Math.Min(historyCount, offset)); if (Offset == 0 && !Locked) Unread = 0; }
        public void Lock(bool locked) { Locked = locked; if (!locked && Offset == 0) Unread = 0; }
        public void Latest() { Offset = 0; Locked = false; Unread = 0; }
    }
    // 与窗口分离的 VT 状态机，按数据流解析，转义序列可以跨任意网络分块。
    public sealed class Cell {
        public string Text = " ";
        public int Foreground = 7, Background = -1;
        public bool Bold;
        public Cell Copy() { return (Cell)MemberwiseClone(); }
    }
    public sealed class Screen {
        public int Columns, Rows, X, Y;
        public bool CursorVisible = true, ApplicationCursor, BracketedPaste;
        public Cell[][] Lines;
        public readonly ScrollbackBuffer History = new ScrollbackBuffer(5000);
        public bool Alternate { get { return alternate; } }
        public Action<string> Reply;
        int fg = 7, bg = -1, savedX, savedY, top, bottom;
        bool bold, wrapPending, alternate;
        Cell[][] primary;
        int primaryX, primaryY;
        int state;
        char high;
        readonly StringBuilder sequence = new StringBuilder();
        public Screen(int columns, int rows) { Resize(columns, rows); }
        Cell Blank() { return new Cell { Foreground = fg, Background = bg, Bold = bold }; }
        Cell[] Line() { return Enumerable.Range(0, Columns).Select(_ => Blank()).ToArray(); }
        public void Resize(int columns, int rows) {
            columns = Math.Max(20, Math.Min(400, columns)); rows = Math.Max(4, Math.Min(200, rows));
            var old = Lines; Columns = columns; Rows = rows;
            Lines = Enumerable.Range(0, rows).Select(_ => Line()).ToArray();
            int removed = old != null && !alternate ? Math.Max(0, Math.Min(old.Length - rows, Y - rows + 1)) : 0;
            if (removed > 0) { for (int y = 0; y < removed; y++) History.Add(old[y]); Y -= removed; }
            if (old != null) for (int y = 0; y < Math.Min(rows, old.Length); y++)
                Array.Copy(old[y + removed], Lines[y], Math.Min(columns, old[y + removed].Length));
            if (primary != null) {
                var resized = Enumerable.Range(0, rows).Select(_ => Line()).ToArray();
                for (int y = 0; y < Math.Min(rows, primary.Length); y++) Array.Copy(primary[y], resized[y], Math.Min(columns, primary[y].Length));
                primary = resized;
            }
            X = Math.Min(X, Columns - 1); Y = Math.Min(Y, Rows - 1); top = 0; bottom = Rows - 1; wrapPending = false;
        }
        public void Feed(string text) {
            foreach (char c in text) {
                if (state == 3) { if (c == '\a') state = 0; else if (c == '\x1b') state = 4; continue; }
                if (state == 4) { state = c == '\\' ? 0 : 3; continue; }
                if (state == 5) { state = 0; continue; }
                if (state == 1) {
                    state = 0;
                    if (c == '[') { state = 2; sequence.Clear(); }
                    else if (c == ']' || c == 'P' || c == '^' || c == '_') state = 3;
                    else if (c == '(' || c == ')') state = 5;
                    else if (c == '7') { savedX = X; savedY = Y; }
                    else if (c == '8') { X = savedX; Y = savedY; }
                    else if (c == 'D') NewLine();
                    else if (c == 'E') { X = 0; NewLine(); }
                    else if (c == 'M') { if (Y == top) Scroll(-1); else Y = Math.Max(0, Y - 1); }
                    else if (c == 'c') Reset();
                    continue;
                }
                if (state == 2) {
                    if (c >= '@' && c <= '~') { Execute(c, sequence.ToString()); state = 0; }
                    else if (sequence.Length < 256) sequence.Append(c);
                    else { sequence.Clear(); state = 0; }
                    continue;
                }
                if (c == '\x1b') { state = 1; continue; }
                if (c == '\r') { X = 0; wrapPending = false; continue; }
                if (c == '\n' || c == '\v' || c == '\f') { NewLine(); continue; }
                if (c == '\b') { X = Math.Max(0, X - 1); wrapPending = false; continue; }
                if (c == '\t') { X = Math.Min(Columns - 1, (X / 8 + 1) * 8); continue; }
                if (c < ' ' || c == '\x7f') continue;
                if (char.IsHighSurrogate(c)) { high = c; continue; }
                string glyph = high != 0 && char.IsLowSurrogate(c) ? new string(new[] { high, c }) : c.ToString(); high = '\0';
                if (glyph.Length == 1 && char.IsSurrogate(glyph[0])) glyph = "\uFFFD";
                int cp = char.ConvertToUtf32(glyph, 0);
                if (System.Globalization.CharUnicodeInfo.GetUnicodeCategory(glyph, 0) == System.Globalization.UnicodeCategory.NonSpacingMark) {
                    if (X > 0) Lines[Y][X - 1].Text += glyph; continue;
                }
                int width = Wide(cp) ? 2 : 1;
                if (wrapPending || X + width > Columns) { X = 0; NewLine(); }
                Lines[Y][X] = new Cell { Text = glyph, Foreground = fg, Background = bg, Bold = bold };
                if (width == 2) Lines[Y][X + 1] = new Cell { Text = "", Foreground = fg, Background = bg };
                X += width;
                if (X >= Columns) { X = Columns - 1; wrapPending = true; }
            }
        }
        static bool Wide(int c) { return c >= 0x1100 && (c <= 0x115f || c >= 0x2e80 && c <= 0xa4cf || c >= 0xac00 && c <= 0xd7a3 || c >= 0xf900 && c <= 0xfaff || c >= 0xfe10 && c <= 0xfe6f || c >= 0xff01 && c <= 0xff60 || c >= 0x1f300); }
        void NewLine() { wrapPending = false; if (Y == bottom) Scroll(1); else Y = Math.Min(Rows - 1, Y + 1); }
        void Scroll(int direction) {
            if (direction > 0) {
                if (!alternate && top == 0 && bottom == Rows - 1) History.Add(Lines[0]);
                for (int y = top; y < bottom; y++) Lines[y] = Lines[y + 1]; Lines[bottom] = Line();
            } else { for (int y = bottom; y > top; y--) Lines[y] = Lines[y - 1]; Lines[top] = Line(); }
        }
        void Reset() { fg = 7; bg = -1; bold = false; X = Y = 0; top = 0; bottom = Rows - 1; wrapPending = false; Lines = Enumerable.Range(0, Rows).Select(_ => Line()).ToArray(); }
        int Value(int[] p, int i, int fallback) { return i < p.Length && p[i] > 0 ? p[i] : fallback; }
        void Erase(int y, int start, int end) { for (int x = Math.Max(0, start); x <= Math.Min(Columns - 1, end); x++) Lines[y][x] = Blank(); }
        void Execute(char command, string raw) {
            bool mode = raw.StartsWith("?");
            int[] p = raw.TrimStart('?', '>').Split(';').Select(s => { int parsed; return int.TryParse(s, out parsed) ? parsed : 0; }).ToArray();
            int n = Math.Min(1000, Value(p, 0, 1));
            if (mode && (command == 'h' || command == 'l')) {
                bool enabled = command == 'h';
                foreach (int v in p) {
                    if (v == 25) CursorVisible = enabled;
                    if (v == 1) ApplicationCursor = enabled;
                    if (v == 2004) BracketedPaste = enabled;
                    if ((v == 1049 || v == 47 || v == 1047) && alternate != enabled) {
                        if (enabled) { primary = Lines; primaryX = X; primaryY = Y; alternate = true; Reset(); }
                        else { Lines = primary; primary = null; X = Math.Min(primaryX, Columns - 1); Y = Math.Min(primaryY, Rows - 1); alternate = false; top = 0; bottom = Rows - 1; }
                    }
                }
                return;
            }
            if (command != 'm') wrapPending = false;
            switch (command) {
                case 'A': Y = Math.Max(0, Y - n); break;
                case 'B': case 'e': Y = Math.Min(Rows - 1, Y + n); break;
                case 'C': case 'a': X = Math.Min(Columns - 1, X + n); break;
                case 'D': X = Math.Max(0, X - n); break;
                case 'E': Y = Math.Min(Rows - 1, Y + n); X = 0; break;
                case 'F': Y = Math.Max(0, Y - n); X = 0; break;
                case 'G': case '`': X = Math.Min(Columns - 1, n - 1); break;
                case 'd': Y = Math.Min(Rows - 1, n - 1); break;
                case 'H': case 'f': Y = Math.Min(Rows - 1, Value(p, 0, 1) - 1); X = Math.Min(Columns - 1, Value(p, 1, 1) - 1); break;
                case 'J':
                    if (p[0] == 2 || p[0] == 3) { for (int y = 0; y < Rows; y++) Erase(y, 0, Columns - 1); if (p[0] == 3) History.Clear(); }
                    else if (p[0] == 0) { Erase(Y, X, Columns - 1); for (int y = Y + 1; y < Rows; y++) Erase(y, 0, Columns - 1); }
                    else { for (int y = 0; y < Y; y++) Erase(y, 0, Columns - 1); Erase(Y, 0, X); } break;
                case 'K': Erase(Y, p[0] == 0 ? X : 0, p[0] == 1 ? X : Columns - 1); break;
                case 'X': Erase(Y, X, X + n - 1); break;
                case 'P': for (int x = X; x < Columns; x++) Lines[Y][x] = x + n < Columns ? Lines[Y][x + n] : Blank(); break;
                case '@': for (int x = Columns - 1; x >= X; x--) Lines[Y][x] = x - n >= X ? Lines[Y][x - n] : Blank(); break;
                case 'L': for (int k = 0; k < Math.Min(n, Rows); k++) { for (int y = bottom; y > Y; y--) Lines[y] = Lines[y - 1]; Lines[Y] = Line(); } break;
                case 'M': for (int k = 0; k < Math.Min(n, Rows); k++) { for (int y = Y; y < bottom; y++) Lines[y] = Lines[y + 1]; Lines[bottom] = Line(); } break;
                case 'S': for (int k = 0; k < Math.Min(n, Rows); k++) Scroll(1); break;
                case 'T': for (int k = 0; k < Math.Min(n, Rows); k++) Scroll(-1); break;
                case 'r': top = Math.Min(Rows - 1, Value(p, 0, 1) - 1); bottom = Math.Min(Rows - 1, Value(p, 1, Rows) - 1); if (bottom <= top) { top = 0; bottom = Rows - 1; } X = Y = 0; break;
                case 's': savedX = X; savedY = Y; break;
                case 'u': X = Math.Min(Columns - 1, savedX); Y = Math.Min(Rows - 1, savedY); break;
                case 'n': if (p[0] == 6 && Reply != null) Reply("\x1b[" + (Y + 1) + ";" + (X + 1) + "R"); else if (p[0] == 5 && Reply != null) Reply("\x1b[0n"); break;
                case 'c': if (Reply != null) Reply("\x1b[?1;2c"); break;
                case 'm':
                    for (int i = 0; i < p.Length; i++) {
                        int v = p[i];
                        if (v == 0) { fg = 7; bg = -1; bold = false; }
                        else if (v == 1) bold = true; else if (v == 22) bold = false;
                        else if (v == 7) { int temp = fg; fg = bg < 0 ? 0 : bg; bg = temp; }
                        else if (v == 39) fg = 7; else if (v == 49) bg = -1;
                        else if (v >= 30 && v <= 37) fg = v - 30; else if (v >= 40 && v <= 47) bg = v - 40;
                        else if (v >= 90 && v <= 97) fg = v - 90 + 8; else if (v >= 100 && v <= 107) bg = v - 100 + 8;
                        else if ((v == 38 || v == 48) && i + 2 < p.Length && p[i + 1] == 5) { int color = Math.Max(0, Math.Min(255, p[i + 2])); if (v == 38) fg = color; else bg = color; i += 2; }
                        else if ((v == 38 || v == 48) && i + 4 < p.Length && p[i + 1] == 2) { int color = 0x1000000 | (Math.ClampByte(p[i + 2]) << 16) | (Math.ClampByte(p[i + 3]) << 8) | Math.ClampByte(p[i + 4]); if (v == 38) fg = color; else bg = color; i += 4; }
                    } break;
            }
        }
        public string Text() { return string.Join("\n", Lines.Select(line => string.Concat(line.Select(c => c.Text)).TrimEnd())); }
    }
    static class Math {
        public static int Min(int a, int b) { return System.Math.Min(a, b); }
        public static int Max(int a, int b) { return System.Math.Max(a, b); }
        public static int ClampByte(int v) { return Max(0, Min(255, v)); }
    }
}
