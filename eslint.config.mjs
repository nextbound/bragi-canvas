import tsparser from '@typescript-eslint/parser'
import { defineConfig } from 'eslint/config'
import obsidianmd from 'eslint-plugin-obsidianmd'

export default defineConfig([
	{
		linterOptions: {
			reportUnusedDisableDirectives: 'off',
		},
	},
	{
		ignores: [
			'dist/**',
			'node_modules/**',
			'custom-plugin-snapshot/**',
			'main.js',
			'package-lock.json',
			'src/mcp-server.ts',
		],
	},
	...obsidianmd.configs.recommended,
	{
		files: ['src/**/*.ts'],
		ignores: ['src/mcp-server.ts'],
		languageOptions: {
			parser: tsparser,
			parserOptions: {
				project: './tsconfig.json',
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			'@typescript-eslint/no-unsafe-argument': 'off',
			'@typescript-eslint/no-unsafe-assignment': 'off',
			'@typescript-eslint/no-unsafe-call': 'off',
			'@typescript-eslint/no-unsafe-member-access': 'off',
			'@typescript-eslint/no-unsafe-return': 'off',
		},
	},
])
