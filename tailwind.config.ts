import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      boxShadow: {
        glow: '0 0 0 1px rgba(255,255,255,0.08), 0 24px 80px rgba(14, 22, 38, 0.28)'
      },
      colors: {
        ink: {
          950: '#07111f',
          900: '#0b1728',
          800: '#11213a'
        },
        accent: {
          500: '#ffb34d',
          600: '#ff9b2f'
        }
      }
    }
  },
  plugins: []
};

export default config;