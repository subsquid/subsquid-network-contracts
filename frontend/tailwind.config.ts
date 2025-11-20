import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        sqd: {
          primary: "#f0f2f5",
          secondary: "#8596ad",
          accent: "#726fff",
          success: "#248a0f",
          error: "#ff2a00",
          warning: "#ffa800",
          text: {
            primary: "#0d0d0d",
            secondary: "#3e4a5c",
            disabled: "#c2cad6",
          },
          bg: {
            paper: "#f0f2f5",
            default: "#ffffff",
          },
          divider: "#d6d8dc",
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        xs: '2px',
        sm: '4px',
        DEFAULT: '8px',
        lg: '12px',
        xl: '16px',
        full: '360px',
      },
      spacing: {
        '4.5': '18px',
      },
    },
  },
  plugins: [],
};
export default config;
