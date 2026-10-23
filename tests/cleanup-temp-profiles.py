#!/usr/bin/env python3
"""清理本次实验在 %TEMP% 下创建的一次性 Chrome profile 目录。

只匹配前缀 chatgpt-lifecycle-* / chatgpt-task-e2e-*，且必须确实位于系统临时目录下。
按本机规矩：分块（每块 12 个文件）+ 每文件 3 次重试 + 写 CSV 断点日志，
全部文件删完后再自底向上 rmdir。绝不碰任何未匹配前缀的路径。

用法：
  python cleanup-temp-profiles.py            # 预演（只列清单）
  python cleanup-temp-profiles.py --apply    # 真正执行
"""
import csv
import os
import sys
import tempfile
import time

PREFIXES = ("chatgpt-lifecycle-", "chatgpt-task-e2e-")
CHUNK = 12
RETRY = 3
LOG = os.path.join(tempfile.gettempdir(), "cleanup-temp-profiles.csv")

APPLY = "--apply" in sys.argv


def targets():
    root = tempfile.gettempdir()
    out = []
    for name in sorted(os.listdir(root)):
        if not name.startswith(PREFIXES):
            continue
        p = os.path.join(root, name)
        if not os.path.isdir(p):
            continue
        # 安全前提：必须在临时目录下，且 basename 命中前缀
        if os.path.commonpath([os.path.abspath(p), os.path.abspath(root)]) != os.path.abspath(root):
            print(f"  SKIP(越界): {p}")
            continue
        out.append(p)
    return out


def walk_files(d):
    for r, _dirs, files in os.walk(d):
        for f in files:
            yield os.path.join(r, f)


def main():
    ts = targets()
    if not ts:
        print("没有匹配的临时目录。")
        return 0

    total_files = 0
    total_bytes = 0
    for d in ts:
        n = 0
        b = 0
        for f in walk_files(d):
            n += 1
            try:
                b += os.path.getsize(f)
            except OSError:
                pass
        total_files += n
        total_bytes += b
        print(f"  {d}  {n} 文件  {b/1048576:.1f} MB")

    print(f"\n合计 {len(ts)} 个目录 / {total_files} 个文件 / {total_bytes/1048576:.1f} MB")
    if not APPLY:
        print("\n（预演模式。加 --apply 执行删除。）")
        return 0

    done = 0
    failed = []
    with open(LOG, "a", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        files = []
        for d in ts:
            files.extend(walk_files(d))
        for i in range(0, len(files), CHUNK):
            for f in files[i:i + CHUNK]:
                ok = False
                for attempt in range(RETRY):
                    try:
                        os.unlink(f)
                        ok = True
                        break
                    except FileNotFoundError:
                        ok = True
                        break
                    except OSError:
                        time.sleep(0.15)
                w.writerow([f, "ok" if ok else "fail"])
                if ok:
                    done += 1
                else:
                    failed.append(f)
            fh.flush()
            if (i // CHUNK) % 20 == 0:
                print(f"  ...{done} 个文件已删", flush=True)

    print(f"文件删除：{done} 成功 / {len(failed)} 失败")

    # 自底向上删空目录
    removed_dirs = 0
    for d in ts:
        for r, dirs, _f in os.walk(d, topdown=False):
            for name in dirs + [""]:
                p = r if name == "" else os.path.join(r, name)
                if p == d and name == "":
                    continue
                try:
                    if not os.listdir(p):
                        os.rmdir(p)
                        removed_dirs += 1
                except OSError:
                    pass
        try:
            if not os.listdir(d):
                os.rmdir(d)
                removed_dirs += 1
        except OSError as e:
            print(f"  目录未删净 {d}: {e}")

    print(f"目录删除：{removed_dirs}")
    print(f"日志：{LOG}")
    return 0


sys.exit(main())
