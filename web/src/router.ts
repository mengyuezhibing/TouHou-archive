import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';

export const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/dashboard' },
  { path: '/dashboard', component: () => import('./views/DashboardView.vue'), meta: { title: '工作台', sub: '总览与快速入口' } },
  { path: '/games', component: () => import('./views/GamesView.vue'), meta: { title: '游戏管理', sub: '扫描本地东方作品并建立索引' } },
  { path: '/extract', component: () => import('./views/ExtractView.vue'), meta: { title: '解包中心', sub: '解析 DAT 归档并导出资源' } },
  { path: '/assets', component: () => import('./views/AssetsView.vue'), meta: { title: '素材浏览器', sub: '浏览、筛选与标注提取出的素材' } },
  { path: '/animation', component: () => import('./views/AnimationView.vue'), meta: { title: '动画分析器', sub: 'ANM 精灵表、动画脚本与图集导出' } },
  { path: '/danmaku', component: () => import('./views/DanmakuView.vue'), meta: { title: '弹幕分析器', sub: 'ECL 参数画像、弹幕模拟与编辑器' } },
  { path: '/spells', component: () => import('./views/SpellView.vue'), meta: { title: '符卡数据库', sub: '符卡归档、设计评价与研究笔记' } },
  { path: '/bgm', component: () => import('./views/BgmView.vue'), meta: { title: 'BGM 曲库', sub: '曲目提取、Boss 关联与场景标注' } },
  { path: '/text', component: () => import('./views/TextView.vue'), meta: { title: '文本分析', sub: '剧情文本检索与对话研究' } },
  { path: '/characters', component: () => import('./views/CharactersView.vue'), meta: { title: '角色库', sub: '角色归类、素材关联与配色画像' } },
  { path: '/enemies', component: () => import('./views/EnemiesView.vue'), meta: { title: '怪物库', sub: '敌机类型与研究记录' } },
  { path: '/studio', component: () => import('./views/StudioView.vue'), meta: { title: '设计工坊', sub: 'Boss / 武器 / 局外成长设计器' } },
  { path: '/notes', component: () => import('./views/NotesView.vue'), meta: { title: '创作笔记', sub: '沉淀研究结论与设计启示' } },
  { path: '/export', component: () => import('./views/ExportView.vue'), meta: { title: '导出中心', sub: '转换为 Godot / Unity / JSON 资源' } },
  { path: '/settings', component: () => import('./views/SettingsView.vue'), meta: { title: '设置', sub: '路径、缓存、偏好与格式支持矩阵' } },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});
