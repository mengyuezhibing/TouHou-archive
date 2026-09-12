import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * 静态发布模式（VITE_TRS_STATIC=1）：
 * 产物要能部署到任意子路径（如 GitHub Pages 的项目站点 /TouHou-archive/），
 * 因此使用相对 base，让资源引用跟随 index.html 所在位置解析。
 * 本地开发 / 本地服务模式仍用绝对 base，以配合 /api 与 /files 代理。
 */
const staticMode = process.env.VITE_TRS_STATIC === '1';

export default defineConfig({
  base: staticMode ? './' : '/',
  plugins: [vue()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
      '/files': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  // 构建产物统一输出到 web/dist，由 publish 脚本收集进站点目录，
  // 这样「构建」与「发布」两步职责清晰，且 publish 可单独重复执行
});
