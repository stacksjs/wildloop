import type { PickierOptions } from 'pickier'

const config: PickierOptions = {
  verbose: false,
  ignores: [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/.nuxt/**',
    '**/.output/**',
    '**/coverage/**',
    '**/*.min.js',
    '**/*.min.css',
    '**/vendor/**',
    // Generated files with inconsistent formatting
    '**/storage/framework/requests/**',
    '**/storage/framework/types/**',
    '**/storage/framework/orm/**',
    '**/storage/framework/actions/**',
    '**/storage/framework/mobile/**',
    // Written by the auto-import generator, and its `declare global` block of
    // `const x: typeof autoImports.x` reads to the linter as ~70 unused
    // variables. Regenerated on every build, so editing it to satisfy the
    // linter would not survive.
    '**/storage/framework/auto-imports/**',
    // The compiled native bundle. Written by `bun run build:native-screens`,
    // minified, and never committed — a stale copy of it was tracked until the
    // lint cache went cold and reported 455 problems in generated output.
    '**/storage/framework/native/**',
    // Skill scripts vendored in by the framework, not ours to lint.
    '**/storage/framework/defaults/ai/skills/**',
    '**/bun-queue/**',
    // Generated declaration files
    '**/*.d.ts',
    '**/temp/**',
    // Files with template literals that have intentional formatting
    '**/error-handling/src/error-page.ts',
    '**/ai/src/buddy.ts',
    '**/orm/src/generate.ts',
  ],
  lint: {
    extensions: ['ts', 'js'],
    reporter: 'stylish',
    cache: true,
    maxWarnings: -1,
  },
  format: {
    extensions: ['ts', 'js', 'json', 'md'],
    trimTrailingWhitespace: true,
    maxConsecutiveBlankLines: 1,
    finalNewline: 'one',
    indent: 2,
    indentStyle: 'spaces',
    quotes: 'single',
    semi: false,
  },
  rules: {
    noDebugger: 'error',
    noConsole: 'off',
    noUnusedCapturingGroup: 'off',
  },
  pluginRules: {
    'ts/no-top-level-await': 'off',
    'no-super-linear-backtracking': 'off',
    'indent': 'off',
    '@stylistic/indent': 'off',
    'style/indent': 'off',
    'quotes': 'off',
    'style/brace-style': 'off',
    'max-statements-per-line': 'off',
  },
}

export default config
