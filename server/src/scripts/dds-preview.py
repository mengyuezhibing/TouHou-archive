#!/usr/bin/env python3
"""DDS → PNG 预览图转换。

用法: python3 dds-preview.py <输入> <输出> [最长边]

TH06NC 的贴图是 BC7 压缩的 DDS，浏览器渲染不了；这里用 Pillow（C 实现，
8192x8192 解码约 0.3s）解成 RGBA、缩到最长边以内，另存为 PNG。
成功退出 0；失败非 0 并把原因打到 stderr。

 Pillow 的 DDS 插件按需解码 mip 链的第一层，即最大那级——正是预览想要的。
"""
import os
import sys
from PIL import Image

# 4096x8192 这类大图会被 Pillow 默认的像素上限拦下，预览场景明确要放开
Image.MAX_IMAGE_PIXELS = None


def main() -> int:
    if len(sys.argv) < 3:
        print('用法: dds-preview.py <输入> <输出> [最长边]', file=sys.stderr)
        return 2
    src, dst = sys.argv[1], sys.argv[2]
    max_side = int(sys.argv[3]) if len(sys.argv) > 3 else 1024

    try:
        img = Image.open(src)
        img.load()
    except Exception as exc:  # 解码失败的原因必须透传，方便排查格式缺口
        print(f'解码失败: {exc}', file=sys.stderr)
        return 1

    img = img.convert('RGBA')
    w, h = img.size
    if max(w, h) > max_side:
        if w >= h:
            nw, nh = max_side, max(1, round(h * max_side / w))
        else:
            nw, nh = max(1, round(w * max_side / h)), max_side
        img = img.resize((nw, nh), Image.LANCZOS)

    tmp = dst + '.tmp.png'
    try:
        img.save(tmp, 'PNG')
        os.replace(tmp, dst)
    except Exception as exc:
        print(f'写出失败: {exc}', file=sys.stderr)
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
