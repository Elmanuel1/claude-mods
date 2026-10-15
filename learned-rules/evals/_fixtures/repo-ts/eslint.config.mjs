import tseslint from 'typescript-eslint'

export default tseslint.config(...tseslint.configs.recommended, {
  rules: {
    'no-restricted-syntax': ['error', { selector: 'ExportDefaultDeclaration', message: 'Named exports only (CLAUDE.md).' }],
  },
})
