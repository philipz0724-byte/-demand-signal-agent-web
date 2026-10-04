import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/-demand-signal-agent-web/',
  plugins: [react()],
})
