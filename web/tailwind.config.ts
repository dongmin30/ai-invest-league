import type { Config } from 'tailwindcss';

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Korean market convention: up is red, down is blue.
        // Channels live in index.css and are lightened in dark mode for contrast.
        up: 'rgb(var(--color-up) / <alpha-value>)',
        down: 'rgb(var(--color-down) / <alpha-value>)',
      },
    },
  },
  plugins: [],
} satisfies Config;
