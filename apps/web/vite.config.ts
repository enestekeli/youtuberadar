import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    /**
     * IPv4 loopback'e sabitlenmiş. Varsayılan `localhost` bazı makinelerde
     * yalnızca `::1`e (IPv6) çözülüyor ve `127.0.0.1` ile açılmıyor.
     * Ağ arayüzlerine bağlanmıyor: araç yerelde kalır.
     */
    host: '127.0.0.1',
    port: 5179,
    // Arayüz ve sunucu ayrı portlarda geliştirilir; üretimde tek origin.
    proxy: {
      '/api': 'http://127.0.0.1:5178',
      '/ws': { target: 'ws://127.0.0.1:5178', ws: true },
    },
  },
});
