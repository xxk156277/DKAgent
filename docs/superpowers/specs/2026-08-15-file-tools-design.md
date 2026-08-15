# DKAgent 文件工具设计

## 目标

在 DKAgent 现有 `ToolRegistry` 中新增四个文件工具：

- `read_file`：读取文本文件，可指定起始行和最大行数。
- `find_files`：使用 glob 查找文件。
- `grep_files`：查找文件内容并返回文件路径、行号和匹配文本。
- `write_file`：创建或覆盖文本文件，必要时自动创建父目录。

本次只增加文件工具，不引入完整 Pi Agent、MCP、Shell 工具、图片读取、远程文件系统或沙箱。

## 设计原则

参考 Pi 的工具参数和路径行为，但使用 DKAgent 自己的 `Tool` 接口、`ToolResult` 和 `ToolRegistry`，不复制 Pi 的 TUI、图片、TypeBox、远程 Operations 与渲染代码。最小 MVP 以“自研代码和概念最少、最好理解”为准，不以依赖数量最少为目标；成熟依赖已经封装好的能力直接复用。

所有工具在创建时接收同一个 `cwd`：

```text
createToolRegistry(cwd = process.cwd())
    ├── createReadFileTool(cwd)
    ├── createFindFilesTool(cwd)
    ├── createGrepFilesTool(cwd)
    └── createWriteFileTool(cwd)
```

## 路径规则

路径行为与 Pi 保持一致：

- 相对路径基于创建工具时的 `cwd` 解析。
- 绝对路径直接使用。
- 允许 `../` 访问 `cwd` 外部。
- 支持 `~` 和 `~/` 展开到用户主目录。
- 不增加 workspace root 限制或路径沙箱。

该设计意味着模型可以访问 `cwd` 外部文件。调用方负责选择可信模型和合适的启动目录。

## 工具契约

### `read_file`

输入：

```ts
interface ReadFileInput {
    path: string;
    offset?: number; // 从 1 开始
    limit?: number;  // 默认 500
}
```

行为：

- 使用 UTF-8 读取文本文件。
- `offset` 必须大于等于 1，`limit` 必须大于等于 1。
- 返回实际路径、选中的文本、起止行和文件总行数。
- 未指定 `limit` 时最多返回 500 行。

### `find_files`

输入：

```ts
interface FindFilesInput {
    pattern: string;
    path?: string;  // 默认 cwd
    limit?: number; // 默认 1000
}
```

行为：

- 使用 `globby` 查找文件，不自行实现目录遍历、glob 或 ignore 解析。
- 设置 `gitignore: true`，使 `.gitignore` 的排除规则优先于用户 glob。
- 使用 `globbyStream` 逐项读取，在达到 `limit` 或收到 `AbortSignal` 时停止遍历。
- 返回相对于搜索目录的文件路径数组。
- 没有匹配文件时成功返回空数组。

### `grep_files`

输入：

```ts
interface GrepFilesInput {
    pattern: string;
    path?: string;       // 默认 cwd
    glob?: string;
    ignoreCase?: boolean;
    literal?: boolean;
    limit?: number;      // 默认 100
}
```

行为：

- 使用 `@vscode/ripgrep` 提供当前平台的 `rgPath`，再执行 `rg --line-number --color never` 查找内容。
- `literal` 为 `true` 时传入 `--fixed-strings`。
- `ignoreCase` 为 `true` 时传入 `--ignore-case`。
- 返回结构化的文件路径、行号和文本。
- ripgrep 退出码 `1` 表示没有匹配，成功返回空数组；其他非零退出码返回错误。

### `write_file`

输入：

```ts
interface WriteFileInput {
    path: string;
    content: string;
}
```

行为：

- 自动递归创建父目录。
- 使用 UTF-8 创建或覆盖文件。
- 返回实际路径、UTF-8 字节数和是否覆盖既有文件。

## 依赖与命令执行

- `find_files` 依赖 `globby`，直接使用其 glob、`.gitignore` 和流式遍历能力。
- `grep_files` 依赖 `@vscode/ripgrep`。该包随当前平台安装预构建的 ripgrep，并导出 `rgPath`，不要求用户额外安装系统命令，也不在运行时下载二进制。
- `grep_files` 使用 `execFile(rgPath, args)`，参数通过数组传递，不构造 Shell 字符串，并把 `ToolContext.abortSignal` 传给子进程。

## 错误处理

- 参数非法：`input_error`。
- 文件无权限：`permission_denied`。
- 操作被中止：`timeout`。
- 文件系统、globby 或 ripgrep 失败：`service_error`。
- `find_files`、`grep_files` 无结果不是错误。

所有错误通过现有 `ToolResult` 返回，不让预期的文件或搜索错误逃逸到 `Dispatcher`。

## 文件结构

```text
packages/agent/src/tools/
├── filesystem/
│   ├── path.ts
│   ├── read-file.ts
│   ├── find-files.ts
│   ├── grep-files.ts
│   └── write-file.ts
└── index.ts

packages/agent/test/tools/
└── filesystem-tools.test.ts
```

`path.ts` 只负责路径解析和 `~` 展开，不引入文件系统 Backend 抽象。

## 测试与完成标准

按 TDD 顺序逐个实现，并覆盖：

1. `read_file` 能读取相对路径、绝对路径、`../` 路径及指定行范围。
2. `read_file` 能拒绝非法的 `offset` 和 `limit`。
3. `find_files` 能按 glob 返回文件，并在无匹配时返回空数组。
4. `grep_files` 能搜索内容、过滤 glob、执行字面量和忽略大小写搜索，并在无匹配时返回空数组。
5. `write_file` 能新建、覆盖文件并自动创建父目录。
6. 搜索工具能响应 `AbortSignal`。
7. `createToolRegistry(cwd)` 注册全部四个工具，同时保留已有工具。
8. 文件工具测试、Agent 全量测试和 TypeScript 类型检查通过。

## 暂不实现

- `edit_file` 或补丁写入。
- 二进制文件及图片读取。
- 文件权限审批。
- workspace root 沙箱。
- 自研外部工具发现、下载或更新管理器。
- SSH、容器或远程文件系统。
- 搜索结果语法高亮和终端渲染。
