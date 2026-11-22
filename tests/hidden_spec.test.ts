// tests/hidden_spec.test.ts: Deep audit and edge-case verification for SPEC.md
import { runCheck } from '../runner.ts';
import type { Check } from '../runner.ts';

interface TestCase {
  name: string;
  check: Check;
  expect: {
    exit: number;
    stdout: string;
    files?: Record<string, string>; // if specified, exact tree match
    filesShouldNotExist?: string[];
  };
}

const tests: TestCase[] = [];

function test(name: string, c: TestCase['check'], exp: TestCase['expect']) {
  tests.push({ name, check: c, expect: exp });
}

// =========================================================================
// 1. Invocation, Options & Exit 2 Precedence
// =========================================================================

test('CLI: -- terminates options and positional argument is stdin dash', {
  id: 'cli-dash-after-sep',
  argv: ['--', '-'],
  stdin: `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,1 +1,1 @@
-hello
+world
`,
  files: { 'a.txt': 'hello\n' }
}, {
  exit: 0,
  stdout: 'M a.txt\nok: 1 file\n',
  files: { 'a.txt': 'world\n' }
});

test('CLI: Multiple valid options in mixed order (--check --strict)', {
  id: 'cli-check-strict-order',
  argv: ['--strict', '--check', 'patch.diff'],
  stdin: null,
  files: {
    'target.txt': 'line 1\nline 2\n',
    'patch.diff': `--- a/target.txt
+++ b/target.txt
@@ -1,2 +1,2 @@
-line 1
+line 1 updated
 line 2
`
  }
}, {
  exit: 0,
  stdout: 'M target.txt\nok: 1 file\n',
  files: {
    'target.txt': 'line 1\nline 2\n', // unchanged because --check
    'patch.diff': `--- a/target.txt
+++ b/target.txt
@@ -1,2 +1,2 @@
-line 1
+line 1 updated
 line 2
`
  }
});

test('CLI: Usage error on bare --format without argument', {
  id: 'cli-usage-bare-format',
  argv: ['--format', 'patch.diff'],
  stdin: null,
  files: { 'patch.diff': 'x' }
}, {
  exit: 2,
  stdout: 'error: usage\n'
});

test('CLI: Usage error on unknown --format value', {
  id: 'cli-usage-unknown-format',
  argv: ['--format=diff-custom', 'patch.diff'],
  stdin: null,
  files: { 'patch.diff': 'x' }
}, {
  exit: 2,
  stdout: 'error: usage\n'
});

test('CLI: Usage error on duplicate flag (--strict --strict)', {
  id: 'cli-usage-dup-strict',
  argv: ['--strict', '--strict', 'patch.diff'],
  stdin: null,
  files: { 'patch.diff': 'x' }
}, {
  exit: 2,
  stdout: 'error: usage\n'
});

test('CLI: Usage error on duplicate format (--format=json --format=v4a)', {
  id: 'cli-usage-dup-format',
  argv: ['--format=json', '--format=v4a', 'patch.diff'],
  stdin: null,
  files: { 'patch.diff': 'x' }
}, {
  exit: 2,
  stdout: 'error: usage\n'
});

test('CLI: Usage error on more than one positional argument', {
  id: 'cli-usage-multi-pos',
  argv: ['p1.diff', 'p2.diff'],
  stdin: null,
  files: { 'p1.diff': 'x', 'p2.diff': 'y' }
}, {
  exit: 2,
  stdout: 'error: usage\n'
});

test('CLI Precedence: Usage error wins over non-existent patch file', {
  id: 'cli-prec-usage-over-no-patch',
  argv: ['--unknown-flag', 'non_existent.diff'],
  stdin: null,
  files: {}
}, {
  exit: 2,
  stdout: 'error: usage\n'
});

test('CLI Precedence: no-patch when file cannot be read', {
  id: 'cli-prec-no-patch',
  argv: ['missing_file.diff'],
  stdin: null,
  files: {}
}, {
  exit: 2,
  stdout: 'error: no-patch\n'
});

test('CLI Precedence: Parse error is reported before any file check on disk', {
  id: 'cli-prec-parse-before-missing',
  argv: ['bad_patch.diff'],
  stdin: null,
  files: {
    // Diff targets non_existent.txt, but has invalid hunk header @@ invalid @@
    'bad_patch.diff': `--- non_existent.txt
+++ non_existent.txt
@@ invalid header @@
-old
+new
`
  }
}, {
  exit: 2,
  stdout: 'error: parse 3\n' // line 3 has the invalid @@ header
});

test('CLI: Empty patch with --format=json throws error: parse 1', {
  id: 'cli-empty-patch-explicit-format',
  argv: ['--format=json'],
  stdin: '',
  files: {}
}, {
  exit: 2,
  stdout: 'error: parse 1\n'
});

test('CLI: Empty patch with --format=v4a throws error: parse 1', {
  id: 'cli-empty-v4a-explicit-format',
  argv: ['--format=v4a'],
  stdin: '',
  files: {}
}, {
  exit: 2,
  stdout: 'error: parse 1\n'
});

test('CLI: Empty patch with --format=unified throws error: parse 1', {
  id: 'cli-empty-unified-explicit-format',
  argv: ['--format=unified'],
  stdin: '',
  files: {}
}, {
  exit: 2,
  stdout: 'error: parse 1\n'
});

// =========================================================================
// 2. Unified Diff Edge Cases (Hunk Offsets, Disambiguation & Ambiguity)
// =========================================================================

test('Unified: Hunk line number wrong but offset d correctly tracked across hunks', {
  id: 'u-hunk-offset-tracking',
  argv: ['patch.diff'],
  stdin: null,
  files: {
    'file.txt': 'line 1\nline 2\nline 3\nline 4\nline 5\n',
    'patch.diff': `--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,3 @@
 line 1
+line 1.5
 line 2
@@ -3,2 +4,3 @@
 line 3
+line 3.5
 line 4
`
  }
}, {
  exit: 0,
  stdout: 'M file.txt\nok: 1 file\n',
  files: {
    'file.txt': 'line 1\nline 1.5\nline 2\nline 3\nline 3.5\nline 4\nline 5\n',
    'patch.diff': `--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,3 @@
 line 1
+line 1.5
 line 2
@@ -3,2 +4,3 @@
 line 3
+line 3.5
 line 4
`
  }
});

test('Unified Disambiguation: Equal distance picks the earlier occurrence', {
  id: 'u-disambig-equal-distance-picks-earlier',
  argv: ['patch.diff'],
  stdin: null,
  files: {
    // "target" is at line index 1 (line 2) and line index 5 (line 6).
    // TargetPos = A - 1 + d. If A = 4, targetPos = 3.
    // Distance from 1 to 3 is 2. Distance from 5 to 3 is 2.
    // "of two equally near, the earlier" -> must pick index 1!
    'code.txt': 'start\ntarget\nfoo\nbar\nbaz\ntarget\nend\n',
    'patch.diff': `--- a/code.txt
+++ b/code.txt
@@ -4,1 +4,1 @@
-target
+replaced
`
  }
}, {
  exit: 0,
  stdout: 'M code.txt\nok: 1 file\n',
  files: {
    'code.txt': 'start\nreplaced\nfoo\nbar\nbaz\ntarget\nend\n',
    'patch.diff': `--- a/code.txt
+++ b/code.txt
@@ -4,1 +4,1 @@
-target
+replaced
`
  }
});

test('Unified Pure Move/Rename without hunks', {
  id: 'u-pure-move-no-hunks',
  argv: ['patch.diff'],
  stdin: null,
  files: {
    'old_name.txt': 'file contents\n',
    'patch.diff': `diff --git a/old_name.txt b/new_name.txt
similarity index 100%
rename from old_name.txt
rename to new_name.txt
`
  }
}, {
  exit: 0,
  stdout: 'R old_name.txt -> new_name.txt\nok: 1 file\n',
  files: {
    'new_name.txt': 'file contents\n',
    'patch.diff': `diff --git a/old_name.txt b/new_name.txt
similarity index 100%
rename from old_name.txt
rename to new_name.txt
`
  },
  filesShouldNotExist: ['old_name.txt']
});

test('Unified: Pure insertion at end of file (O empty) with A beyond line count', {
  id: 'u-empty-o-insertion-at-eof',
  argv: ['patch.diff'],
  stdin: null,
  files: {
    'sample.txt': 'line 1\nline 2\n',
    'patch.diff': `--- a/sample.txt
+++ b/sample.txt
@@ -99,0 +99,1 @@
+appended line
`
  }
}, {
  exit: 0,
  stdout: 'M sample.txt\nok: 1 file\n',
  files: {
    'sample.txt': 'line 1\nline 2\nappended line\n',
    'patch.diff': `--- a/sample.txt
+++ b/sample.txt
@@ -99,0 +99,1 @@
+appended line
`
  }
});

test('Unified: Section creating a file with No newline at end of file', {
  id: 'u-create-no-newline',
  argv: ['patch.diff'],
  stdin: null,
  files: {
    'patch.diff': `--- /dev/null
+++ b/created.txt
@@ -0,0 +1,1 @@
+first line
\\ No newline at end of file
`
  }
}, {
  exit: 0,
  stdout: 'A created.txt\nok: 1 file\n',
  files: {
    'created.txt': 'first line', // no trailing newline
    'patch.diff': `--- /dev/null
+++ b/created.txt
@@ -0,0 +1,1 @@
+first line
\\ No newline at end of file
`
  }
});

test('Unified: Modify file ending at EOF stripping trailing newline', {
  id: 'u-modify-eof-strip-newline',
  argv: ['patch.diff'],
  stdin: null,
  files: {
    'file.txt': 'alpha\nbeta\n',
    'patch.diff': `--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,2 @@
 alpha
-beta
+beta_no_nl
\\ No newline at end of file
`
  }
}, {
  exit: 0,
  stdout: 'M file.txt\nok: 1 file\n',
  files: {
    'file.txt': 'alpha\nbeta_no_nl', // trailing newline stripped
    'patch.diff': `--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,2 @@
 alpha
-beta
+beta_no_nl
\\ No newline at end of file
`
  }
});

// =========================================================================
// 3. 3-Tier Matching, Whitespace Drift & Strict Mode
// =========================================================================

test('Tier 2 Match: Re-indentation preserves non-matching indent & empty lines', {
  id: 'tier2-complex-reindentation',
  argv: ['patch.diff'],
  stdin: null,
  files: {
    // In file: matched first line has 4 spaces indent (F = '    ')
    'code.py': `def foo():
    if True:
        do_work()
`,
    // In patch:
    // Body line 1 has marker ' ' followed by 2 spaces '  ' (P = '  ')
    // Body line 2 has marker '-' followed by 4 spaces
    // Body line 3 has marker '+' followed by 4 spaces: '    new_work()'
    // Since '    new_work()' starts with P ('  '), P is replaced by F ('    ') -> '      new_work()'
    // Body line 4 has marker '+' followed by 'comment()' -> does not start with P -> written as is: 'comment()'
    // Body line 5 has marker '+' followed by '' -> empty -> written as is: ''
    'patch.diff': `--- a/code.py
+++ b/code.py
@@ -2,2 +2,4 @@
   if True:
-    do_work()
+    new_work()
+comment()
+
`
  }
}, {
  exit: 0,
  stdout: 'M code.py\nok: 1 file\n',
  files: {
    'code.py': `def foo():
    if True:
      new_work()
comment()

`,
    'patch.diff': `--- a/code.py
+++ b/code.py
@@ -2,2 +2,4 @@
   if True:
-    do_work()
+    new_work()
+comment()
+
`
  }
});

test('Strict Mode: Tier 1 match fails when --strict is passed', {
  id: 'strict-mode-tier1-fails',
  argv: ['--strict', 'patch.diff'],
  stdin: null,
  files: {
    'file.txt': 'hello\n',
    // Patch has trailing space after 'hello'
    'patch.diff': `--- a/file.txt
+++ b/file.txt
@@ -1,1 +1,1 @@
-hello 
+world
`
  }
}, {
  exit: 1,
  stdout: 'error: no-match file.txt\nfailed: 1 of 1 edits\n'
});

test('Strict Mode: Tier 2 match fails when --strict is passed', {
  id: 'strict-mode-tier2-fails',
  argv: ['--strict', 'patch.diff'],
  stdin: null,
  files: {
    'file.txt': '  indented\n',
    // Patch has different leading indent
    'patch.diff': `--- a/file.txt
+++ b/file.txt
@@ -1,1 +1,1 @@
-indented
+new_indented
`
  }
}, {
  exit: 1,
  stdout: 'error: no-match file.txt\nfailed: 1 of 1 edits\n'
});

test('SEARCH/REPLACE: Fails with ambiguous when old lines occur twice', {
  id: 's-ambiguous-exact-error',
  argv: ['patch.txt'],
  stdin: null,
  files: {
    'dup.txt': 'repeat\nsome text\nrepeat\n',
    'patch.txt': `dup.txt
<<<<<<< SEARCH
repeat
=======
changed
>>>>>>> REPLACE
`
  }
}, {
  exit: 1,
  stdout: 'error: ambiguous dup.txt\nfailed: 1 of 1 edits\n'
});

// =========================================================================
// 4. Line Endings (CRLF vs LF) & File Operations
// =========================================================================

test('CRLF File Preservation: File edited by V4A preserves CRLF breaks', {
  id: 'crlf-v4a-preservation',
  argv: ['edit.patch'],
  stdin: null,
  files: {
    'crlf_file.js': 'function test() {\r\n  return 1;\r\n}\r\n',
    'edit.patch': `*** Begin Patch
*** Update File: crlf_file.js
@@ function test() {
-  return 1;
+  return 2;
*** End Patch
`
  }
}, {
  exit: 0,
  stdout: 'M crlf_file.js\nok: 1 file\n',
  files: {
    'crlf_file.js': 'function test() {\r\n  return 2;\r\n}\r\n',
    'edit.patch': `*** Begin Patch
*** Update File: crlf_file.js
@@ function test() {
-  return 1;
+  return 2;
*** End Patch
`
  }
});

test('Empty File: Changing an empty file to have lines', {
  id: 'empty-file-to-lines',
  argv: ['patch.diff'],
  stdin: null,
  files: {
    'empty.txt': '',
    'patch.diff': `--- a/empty.txt
+++ b/empty.txt
@@ -0,0 +1,1 @@
+hello
`
  }
}, {
  exit: 0,
  stdout: 'M empty.txt\nok: 1 file\n',
  files: {
    'empty.txt': 'hello\n',
    'patch.diff': `--- a/empty.txt
+++ b/empty.txt
@@ -0,0 +1,1 @@
+hello
`
  }
});

// =========================================================================
// 5. Path Safety & Unsafe Errors
// =========================================================================

test('Path Safety: Double slash segment rejection', {
  id: 'path-unsafe-double-slash',
  argv: ['patch.txt'],
  stdin: null,
  files: {
    'patch.txt': `{"command":"create","path":"foo//bar.txt","file_text":"hello"}\n`
  }
}, {
  exit: 1,
  stdout: 'error: unsafe foo//bar.txt\nfailed: 1 of 1 edits\n'
});

test('Path Safety: Dot segment rejection', {
  id: 'path-unsafe-dot-segment',
  argv: ['patch.txt'],
  stdin: null,
  files: {
    'patch.txt': `{"command":"create","path":"foo/./bar.txt","file_text":"hello"}\n`
  }
}, {
  exit: 1,
  stdout: 'error: unsafe foo/./bar.txt\nfailed: 1 of 1 edits\n'
});

test('Path Safety: Path traversal .. rejection', {
  id: 'path-unsafe-parent-traversal',
  argv: ['patch.txt'],
  stdin: null,
  files: {
    'patch.txt': `{"command":"create","path":"../secret.txt","file_text":"hello"}\n`
  }
}, {
  exit: 1,
  stdout: 'error: unsafe ../secret.txt\nfailed: 1 of 1 edits\n'
});

test('Path Safety: Backslash rejection', {
  id: 'path-unsafe-backslash',
  argv: ['patch.txt'],
  stdin: null,
  files: {
    'patch.txt': `{"command":"create","path":"foo\\\\bar.txt","file_text":"hello"}\n`
  }
}, {
  exit: 1,
  stdout: 'error: unsafe foo\\bar.txt\nfailed: 1 of 1 edits\n'
});

test('Path Safety: Leading slash rejection', {
  id: 'path-unsafe-leading-slash',
  argv: ['patch.txt'],
  stdin: null,
  files: {
    'patch.txt': `{"command":"create","path":"/abs/path.txt","file_text":"hello"}\n`
  }
}, {
  exit: 1,
  stdout: 'error: unsafe /abs/path.txt\nfailed: 1 of 1 edits\n'
});

// =========================================================================
// 6. Full Atomic Rollback & Multi-Edit Failures
// =========================================================================

test('Atomicity: Earlier successful edits rolled back when later edit fails', {
  id: 'atomicity-all-or-nothing-rollback',
  argv: ['patch.diff'],
  stdin: null,
  files: {
    'valid1.txt': 'initial 1\n',
    'valid2.txt': 'initial 2\n',
    'patch.diff': `--- a/valid1.txt
+++ b/valid1.txt
@@ -1,1 +1,1 @@
-initial 1
+modified 1
--- a/valid2.txt
+++ b/valid2.txt
@@ -1,1 +1,1 @@
-initial 2
+modified 2
--- a/missing.txt
+++ b/missing.txt
@@ -1,1 +1,1 @@
-old
+new
`
  }
}, {
  exit: 1,
  stdout: 'error: missing missing.txt\nfailed: 1 of 3 edits\n',
  files: {
    // Both files must remain in initial states!
    'valid1.txt': 'initial 1\n',
    'valid2.txt': 'initial 2\n',
    'patch.diff': `--- a/valid1.txt
+++ b/valid1.txt
@@ -1,1 +1,1 @@
-initial 1
+modified 1
--- a/valid2.txt
+++ b/valid2.txt
@@ -1,1 +1,1 @@
-initial 2
+modified 2
--- a/missing.txt
+++ b/missing.txt
@@ -1,1 +1,1 @@
-old
+new
`
  }
});

test('Atomicity: Reports multiple failures in patch order with count', {
  id: 'atomicity-multiple-failures-order',
  argv: ['patch.diff'],
  stdin: null,
  files: {
    'exists_already.txt': 'existing\n',
    'patch.diff': `--- /dev/null
+++ b/exists_already.txt
@@ -0,0 +1,1 @@
+content
--- a/missing_file.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-x
`
  }
}, {
  exit: 1,
  stdout: `error: exists exists_already.txt
error: missing missing_file.txt
failed: 2 of 2 edits
`,
  files: {
    'exists_already.txt': 'existing\n',
    'patch.diff': `--- /dev/null
+++ b/exists_already.txt
@@ -0,0 +1,1 @@
+content
--- a/missing_file.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-x
`
  }
});

// =========================================================================
// 7. Output Format & UTF-8 Sorting
// =========================================================================

test('Output: UTF-8 Byte order sorting with mixed A, D, M, R', {
  id: 'output-utf8-sort-mixed-actions',
  argv: ['patch.diff'],
  stdin: null,
  files: {
    'b_to_move.txt': 'move me\n',
    'c_to_delete.txt': 'delete me\n',
    'd_to_modify.txt': 'mod me\n',
    'patch.diff': `--- a/c_to_delete.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-delete me
--- a/d_to_modify.txt
+++ b/d_to_modify.txt
@@ -1,1 +1,1 @@
-mod me
+modified
--- /dev/null
+++ b/z_created.txt
@@ -0,0 +1,1 @@
+new content
diff --git a/b_to_move.txt b/a_moved.txt
rename from b_to_move.txt
rename to a_moved.txt
`
  }
}, {
  exit: 0,
  // UTF-8 sort key order:
  // a_moved.txt (from R b_to_move.txt -> a_moved.txt)
  // c_to_delete.txt (D)
  // d_to_modify.txt (M)
  // z_created.txt (A)
  stdout: `R b_to_move.txt -> a_moved.txt
D c_to_delete.txt
M d_to_modify.txt
A z_created.txt
ok: 4 files
`,
  files: {
    'a_moved.txt': 'move me\n',
    'd_to_modify.txt': 'modified\n',
    'z_created.txt': 'new content\n',
    'patch.diff': `--- a/c_to_delete.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-delete me
--- a/d_to_modify.txt
+++ b/d_to_modify.txt
@@ -1,1 +1,1 @@
-mod me
+modified
--- /dev/null
+++ b/z_created.txt
@@ -0,0 +1,1 @@
+new content
diff --git a/b_to_move.txt b/a_moved.txt
rename from b_to_move.txt
rename to a_moved.txt
`
  },
  filesShouldNotExist: ['b_to_move.txt', 'c_to_delete.txt']
});

test('Output: No-op patch prints ok: 0 files', {
  id: 'output-noop-patch-ok-0-files',
  argv: ['patch.diff'],
  stdin: null,
  files: {
    'file.txt': 'content\n',
    'patch.diff': `--- a/file.txt
+++ b/file.txt
@@ -1,1 +1,1 @@
-content
+content
`
  }
}, {
  exit: 0,
  stdout: 'ok: 0 files\n',
  files: {
    'file.txt': 'content\n',
    'patch.diff': `--- a/file.txt
+++ b/file.txt
@@ -1,1 +1,1 @@
-content
+content
`
  }
});

// =========================================================================
// 8. Advanced Edge Cases (JSON Overlap, V4A Tiered Anchors, Trailing Newline)
// =========================================================================

test('JSON: str_replace overlapping matches correctly reports ambiguous', {
  id: 'json-str-replace-overlapping-ambiguous',
  argv: ['patch.json'],
  stdin: null,
  files: {
    'file.txt': 'banana\n',
    // 'ana' occurs at index 1 and index 3 in 'banana'
    'patch.json': `[{"command":"str_replace","path":"file.txt","old_str":"ana","new_str":"xyz"}]\n`
  }
}, {
  exit: 1,
  stdout: 'error: ambiguous file.txt\nfailed: 1 of 1 edits\n'
});

test('JSON: insert at line 0 (top of file) preserves file final newline', {
  id: 'json-insert-line-0-top',
  argv: ['patch.json'],
  stdin: null,
  files: {
    'file.txt': 'line 1\nline 2\n',
    'patch.json': `[{"command":"insert","path":"file.txt","insert_line":0,"new_str":"header\\n"}]\n`
  }
}, {
  exit: 0,
  stdout: 'M file.txt\nok: 1 file\n',
  files: {
    'file.txt': 'header\nline 1\nline 2\n'
  }
});

test('JSON: insert with empty new_str does not change lines', {
  id: 'json-insert-empty-new-str',
  argv: ['patch.json'],
  stdin: null,
  files: {
    'file.txt': 'line 1\nline 2\n',
    'patch.json': `[{"command":"insert","path":"file.txt","insert_line":1,"new_str":""}]\n`
  }
}, {
  exit: 0,
  stdout: 'ok: 0 files\n',
  files: {
    'file.txt': 'line 1\nline 2\n'
  }
});

test('V4A: Anchor matches at Tier 1 (trailing whitespace drift on anchor line)', {
  id: 'v4a-anchor-tier1-drift',
  argv: ['patch.txt'],
  stdin: null,
  files: {
    'script.js': 'function foo() {\n  return 42;\n}\n',
    // Patch anchor has trailing spaces
    'patch.txt': `*** Begin Patch
*** Update File: script.js
@@ function foo() {   
-  return 42;
+  return 100;
*** End Patch
`
  }
}, {
  exit: 0,
  stdout: 'M script.js\nok: 1 file\n',
  files: {
    'script.js': 'function foo() {\n  return 100;\n}\n'
  }
});

test('SEARCH/REPLACE: Preserves file without final newline', {
  id: 's-preserve-no-final-newline',
  argv: ['patch.txt'],
  stdin: null,
  files: {
    'file.txt': 'hello world', // no newline at EOF
    'patch.txt': `file.txt
<<<<<<< SEARCH
hello world
=======
hello universe
>>>>>>> REPLACE
`
  }
}, {
  exit: 0,
  stdout: 'M file.txt\nok: 1 file\n',
  files: {
    'file.txt': 'hello universe' // still no newline
  }
});

test('Unified: Multi-file mixed Create, Modify, Rename, Delete in one diff', {
  id: 'u-all-file-operations-in-one-diff',
  argv: ['combo.diff'],
  stdin: null,
  files: {
    'to_delete.txt': 'goodbye\n',
    'to_rename.txt': 'content to move\n',
    'to_modify.txt': 'old text\n',
    'combo.diff': `--- a/to_delete.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-goodbye
--- /dev/null
+++ b/created.txt
@@ -0,0 +1,1 @@
+brand new
--- a/to_modify.txt
+++ b/to_modify.txt
@@ -1,1 +1,1 @@
-old text
+new text
diff --git a/to_rename.txt b/renamed.txt
rename from to_rename.txt
rename to renamed.txt
`
  }
}, {
  exit: 0,
  // Sort order of new paths: created.txt < renamed.txt < to_delete.txt < to_modify.txt
  stdout: `A created.txt
R to_rename.txt -> renamed.txt
D to_delete.txt
M to_modify.txt
ok: 4 files
`,
  files: {
    'created.txt': 'brand new\n',
    'renamed.txt': 'content to move\n',
    'to_modify.txt': 'new text\n'
  },
  filesShouldNotExist: ['to_delete.txt', 'to_rename.txt']
});

// =========================================================================
// RUN TEST RUNNER
// =========================================================================

console.log(`Running ${tests.length} hidden spec audit tests...\n`);
let passedCount = 0;
for (const t of tests) {
  const got = runCheck(t.check);
  const why: string[] = [];

  if (got.exit !== t.expect.exit) {
    why.push(`exit code: got ${got.exit}, expected ${t.expect.exit}`);
  }
  if (got.stdout !== t.expect.stdout) {
    why.push(`stdout mismatch:\n  got:      ${JSON.stringify(got.stdout)}\n  expected: ${JSON.stringify(t.expect.stdout)}`);
  }

  if (t.expect.files) {
    for (const [p, expContent] of Object.entries(t.expect.files)) {
      if (got.files[p] === undefined) {
        why.push(`file ${p} is missing`);
      } else if (got.files[p] !== expContent) {
        why.push(`file ${p} content mismatch:\n  got:      ${JSON.stringify(got.files[p])}\n  expected: ${JSON.stringify(expContent)}`);
      }
    }
  }

  if (t.expect.filesShouldNotExist) {
    for (const p of t.expect.filesShouldNotExist) {
      if (got.files[p] !== undefined) {
        why.push(`file ${p} should not exist but does`);
      }
    }
  }

  if (why.length === 0) {
    passedCount++;
    console.log(`PASS: ${t.name}`);
  } else {
    console.log(`FAIL: ${t.name}`);
    for (const w of why) console.log(`  - ${w}`);
  }
}

console.log(`\n========================================`);
console.log(`Result: ${passedCount} of ${tests.length} passed`);
console.log(`========================================`);

if (passedCount < tests.length) {
  process.exit(1);
}
