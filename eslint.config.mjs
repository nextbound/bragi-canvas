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
			'main.js',
			'package-lock.json',
		],
	},
	...obsidianmd.configs.recommended,
	{ files: ['scripts/**/*.mjs'], rules: { 'obsidianmd/prefer-active-doc': 'off', 'obsidianmd/prefer-active-window-timers': 'off' } },
	{
		files: ['src/**/*.ts'],
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
