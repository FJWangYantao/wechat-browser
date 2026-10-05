// 打包入口：把官方 Anthropic SDK 打成一个 ES 模块，供后台 service worker 直接 import。
// 重新生成：npm install && npm run vendor
export { default as Anthropic } from '@anthropic-ai/sdk';
