/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef4ff',
          100: '#d9e5ff',
          200: '#bcd1ff',
          300: '#8eb2ff',
          400: '#5988ff',
          500: '#3361ff',
          600: '#1d3ff5',
          700: '#162fe1',
          800: '#1829b6',
          900: '#1a298f',
        },
      },
    },
  },
  plugins: [],
};
