# pi 扩展与快捷键

保存自定义扩展、扩展所需的公共代码和 `keybindings.json`，用于多端同步。不包含 settings、模型配置、登录凭据、会话或 npm 安装目录。

```text
my-pi-extensions/
├── extensions/
│   ├── new-pi-tab.ts
│   └── readonly-lock.ts
├── lib/
│   ├── readonly-exec.ts
│   ├── readonly-session.ts
│   └── readonly-shell.ts
└── keybindings.json
```

## 功能

| 来源 | 快捷键或命令 | 功能 |
|---|---|---|
| `new-pi-tab.ts` | `Alt+N` | 在当前工作目录打开 Windows Terminal 新标签页并启动 pi；仅支持 Windows，需要 Windows Terminal 和可直接运行的 `pi` 命令 |
| `readonly-lock.ts` | `Alt+L`、`/lock` | 切换当前会话的只读锁；也支持 `/lock on`、`/lock off`、`/lock status` |
| `keybindings.json` | `Alt+R` | 打开历史会话选择器 |
| `keybindings.json` | `app.session.new: []` | 将“新建会话”动作的快捷键设为空 |

只读锁默认关闭。开启后限制模型调用的工具和 Bash 命令，用户手动输入的 `!` 命令仍按 pi 的正常方式执行。

`readonly-lock.ts` 使用 `../lib/` 中的三个文件，恢复时必须保留目录关系。扩展使用 pi 提供的模块，无需单独安装 npm 依赖。

## 在其他设备恢复

先拉取仓库，再进入 `materials/my-pi-extensions` 目录。以下命令会覆盖目标中的同名文件；目标文件若有需要保留的修改，请先备份。已有其他自定义快捷键时，可以手动合并 `keybindings.json` 的两个配置项。

Windows PowerShell：

```powershell
$piAgentDir = if ($env:PI_CODING_AGENT_DIR) {
    $env:PI_CODING_AGENT_DIR
} else {
    Join-Path $env:USERPROFILE '.pi\agent'
}
New-Item -ItemType Directory -Force "$piAgentDir\extensions", "$piAgentDir\lib" | Out-Null
Copy-Item .\extensions\*.ts "$piAgentDir\extensions\" -Force
Copy-Item .\lib\*.ts "$piAgentDir\lib\" -Force
Copy-Item .\keybindings.json "$piAgentDir\keybindings.json" -Force
```

macOS / Linux（Bash）：

```bash
pi_agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$pi_agent_dir/extensions" "$pi_agent_dir/lib"
cp extensions/*.ts "$pi_agent_dir/extensions/"
cp lib/*.ts "$pi_agent_dir/lib/"
cp keybindings.json "$pi_agent_dir/keybindings.json"
```

恢复后在 pi 中执行 `/reload`，或重启 pi。`Alt+N` 在非 Windows 系统上会提示不支持。

后续同步时，将本机修改过的扩展、依赖文件或快捷键复制回本目录，检查 Git 差异后提交、推送；其他设备拉取后按上述步骤恢复。
