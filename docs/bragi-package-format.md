# Bragi package format

这份文档说明 Bragi Canvas 当前使用的 `.bragi` 导入/导出文件格式，目标是让外部工具也可以合成一个 `.bragi` 文件，然后导入到 Obsidian Canvas 里。

核心结论：`.bragi` 文件本质上是一个 ZIP 包。包里必须有 `canvas.json`，可以有 `manifest.json` 和 `assets/` 文件夹。

实现参考：`src/import-export.ts`。

## 文件结构

一个标准 `.bragi` 包长这样：

```text
example.bragi
├── manifest.json      建议提供，但当前导入器不强制要求
├── canvas.json        必须提供
└── assets/            可选，用来放图片、视频、音频、Markdown 等资源
    ├── image.png
    ├── note.md
    └── nested/file.mp4
```

当前导入行为：

- `canvas.json` 必须存在。
- `manifest.json` 会在 Bragi 导出时生成，但导入时目前不会校验它。
- `assets/` 下的文件会被解压到 Obsidian vault 的 `_bragi/assets/...`。
- 导入时只会自动改写两类路径：
  - 文件节点的 `node.file`
  - 分组节点的 `node.background`
- 其他自定义字段里的路径不会自动改写。

## manifest.json

示例：

```json
{
  "version": 1,
  "bragiVersion": "1.1.0",
  "exportDate": "2026-05-09T00:00:00.000Z",
  "canvasName": "example",
  "nodeCount": 3,
  "assetCount": 1
}
```

字段含义：

- `version`：`.bragi` 包格式版本。当前导出器写入 `1`。
- `bragiVersion`：信息字段，表示导出它的 Bragi 版本或外部生成器名称。
- `exportDate`：导出时间，建议用 ISO 时间字符串。
- `canvasName`：原始画布名称，不带 `.canvas` 后缀。
- `nodeCount`：`canvas.json` 里的节点数量。
- `assetCount`：包内资源文件数量。

外部工具生成 `.bragi` 时建议带上 `manifest.json`，方便人读和未来兼容；但不要依赖它通过当前导入校验，因为当前导入器主要读取 `canvas.json`。

## canvas.json

`canvas.json` 使用 Obsidian 原生 Canvas JSON 结构：

```json
{
  "nodes": [],
  "edges": []
}
```

Bragi Canvas 会保留 Obsidian Canvas 支持的额外字段，所以 Bragi 自己的节点元数据也可以直接放在节点对象上。

## 节点通用规则

每个节点都需要这些基础字段：

```json
{
  "id": "node-1",
  "type": "text",
  "x": 0,
  "y": 0,
  "width": 400,
  "height": 240
}
```

必需字段：

- `id`：字符串，在当前 `canvas.json` 内唯一。
- `type`：节点类型，可以是 `text`、`file`、`link`、`group`。
- `x`、`y`：节点在画布上的位置。
- `width`、`height`：节点尺寸。

可选字段：

- `color`：Obsidian Canvas 节点颜色，通常是 `"1"` 到 `"6"`，也可以是十六进制颜色。Bragi 的 Mark 功能会切换成 `"6"`。

## 文本节点

```json
{
  "id": "prompt",
  "type": "text",
  "text": "Generate a cinematic product image.",
  "x": 0,
  "y": 0,
  "width": 420,
  "height": 180
}
```

文本节点额外必需字段：

- `text`：节点文本内容。

如果这个文本节点是生成目标节点，它可以通过连线接收图片、视频、音频或其他文本作为上游输入。

## 文件节点

```json
{
  "id": "ref-image",
  "type": "file",
  "file": "assets/ref.png",
  "x": -520,
  "y": 0,
  "width": 360,
  "height": 360
}
```

文件节点额外必需字段：

- `file`：vault 相对路径。对于 `.bragi` 包，建议写成包内资源路径，例如 `assets/ref.png`。

导入时，Bragi 会把 `assets/ref.png` 解压到 vault 里的 `_bragi/assets/ref.png`，然后把这个文件节点的 `file` 字段改写成实际解压后的路径。

Bragi 当前识别的媒体类型：

- 图片：`.png`、`.jpg`、`.jpeg`、`.webp`、`.gif`
- 视频：`.mp4`、`.mov`、`.webm`
- 音频：`.mp3`、`.wav`
- Markdown 提示词文件：`.md`

文件节点可选字段：

- `subpath`：Obsidian 文件子路径，例如 `#Heading`。
- `bragiAssetId`：手动设置的 BytePlus / Volcengine Asset ID，主要用于 Seedance face reference 工作流。

不要手动设置：

- `bragiAssetIds`：这是 Bragi 内部的多 provider asset 缓存字段，外部生成包时不要写，让插件自己生成。

## 链接节点

```json
{
  "id": "external-link",
  "type": "link",
  "url": "https://example.com",
  "x": 0,
  "y": 300,
  "width": 400,
  "height": 180
}
```

链接节点额外必需字段：

- `url`：链接地址。

## 分组节点

```json
{
  "id": "group-1",
  "type": "group",
  "label": "References",
  "x": -560,
  "y": -40,
  "width": 460,
  "height": 460,
  "background": "assets/group-bg.png",
  "backgroundStyle": "cover"
}
```

分组节点可选字段：

- `label`：分组名称。
- `background`：背景图片路径。如果它指向 `assets/...`，导入时会被改写成 `_bragi/assets/...` 下的实际路径。
- `backgroundStyle`：可以是 `cover`、`ratio` 或 `repeat`。

## 连线规则

示例：

```json
{
  "id": "edge-1",
  "fromNode": "ref-image",
  "fromSide": "right",
  "fromEnd": "none",
  "toNode": "prompt",
  "toSide": "left",
  "toEnd": "arrow",
  "label": "reference"
}
```

必需字段：

- `id`：字符串，在当前 `canvas.json` 内唯一。
- `fromNode`：起点节点 id。
- `toNode`：终点节点 id。

可选字段：

- `fromSide`：`top`、`right`、`bottom`、`left`
- `toSide`：`top`、`right`、`bottom`、`left`
- `fromEnd`：`none` 或 `arrow`
- `toEnd`：`none` 或 `arrow`
- `color`
- `label`

如果想让某个节点作为 Bragi 生成的输入，它必须用有方向的连线指向目标节点：

- `toNode` 必须是目标提示词/生成节点。
- `toEnd` 建议写 `"arrow"`，也可以省略，省略时 Bragi 会按箭头端处理。
- `fromEnd` 建议写 `"none"`，也可以省略。

Bragi 会忽略无方向连线和双向箭头连线，不会把它们当作生成输入。

## Bragi 自定义节点字段

这些字段都是可选的，直接存储在 Obsidian Canvas 节点对象上。

### 输入顺序

```json
{
  "bragiImageOrder": ["_bragi/assets/ref-a.png", "_bragi/assets/ref-b.png"],
  "bragiTextOrder": ["text-node-a", "text-node-b"],
  "bragiAudioOrder": ["_bragi/assets/voice.wav"]
}
```

字段含义：

- `bragiImageOrder`：上游图片引用的优先顺序。
- `bragiTextOrder`：上游文本节点或 Markdown 节点的优先顺序，存的是节点 id。
- `bragiAudioOrder`：上游音频引用的优先顺序。

重要限制：

当前导入器只会改写 `node.file` 和 `node.background`，不会改写 `bragiImageOrder`、`bragiAudioOrder`、`bragiTextOrder`。

所以外部生成 `.bragi` 时建议：

- 可以完全不写这些顺序字段。
- 如果要写，只把它们当成提示信息，不要依赖它们一定正确。
- 不要依赖 `bragiTextOrder` 在导入后还能对应原节点，因为导入时节点 id 会被重新生成。
- 不要依赖路径顺序字段处理文件重名，因为如果导入时发生文件名冲突，Bragi 会给实际文件加后缀，但不会改写这些自定义路径字段。
- 更稳的方式是把连线按你希望的输入顺序写进 `canvas.json`，当保存的顺序字段不匹配时，Bragi 会回退到上游连线顺序。

### 上次生成配置

```json
{
  "bragiLastGen": {
    "image": {
      "modelId": "gpt-image-2",
      "params": {
        "aspectRatio": "1:1"
      },
      "batchCount": 1
    }
  }
}
```

Bragi 会用这个字段给某个节点预填生成栏配置。它是可选字段。

顶层 key 通常是生成类型，例如：

- `image`
- `video`
- `text`
- `audio`

注意：如果 `modelId` 在当前用户环境里不可用，UI 可能会忽略或无法直接使用它。

### 不要写入运行中状态

外部生成 `.bragi` 时不要写这些字段：

```json
{
  "bragiGenerating": true,
  "bragiGenModelName": "model",
  "bragiGenStartedAt": 1777777777777
}
```

这些字段表示“正在生成”的运行时状态。如果导入后没有对应的内存任务，Bragi 可能会把节点标记成 interrupted。

## 最小可用包示例

ZIP 结构：

```text
minimal.bragi
├── manifest.json
├── canvas.json
└── assets/
    └── ref.png
```

`manifest.json`：

```json
{
  "version": 1,
  "bragiVersion": "external",
  "exportDate": "2026-05-09T00:00:00.000Z",
  "canvasName": "minimal",
  "nodeCount": 2,
  "assetCount": 1
}
```

`canvas.json`：

```json
{
  "nodes": [
    {
      "id": "ref-image",
      "type": "file",
      "file": "assets/ref.png",
      "x": 0,
      "y": 0,
      "width": 360,
      "height": 360
    },
    {
      "id": "prompt",
      "type": "text",
      "text": "Use the connected image as reference and generate a clean product shot.",
      "x": 520,
      "y": 0,
      "width": 460,
      "height": 220
    }
  ],
  "edges": [
    {
      "id": "edge-ref-to-prompt",
      "fromNode": "ref-image",
      "fromSide": "right",
      "fromEnd": "none",
      "toNode": "prompt",
      "toSide": "left",
      "toEnd": "arrow"
    }
  ]
}
```

导入后：

- `assets/ref.png` 会被解压到 `_bragi/assets/ref.png`。
- 如果 `_bragi/assets/ref.png` 已存在，会改名成类似 `_bragi/assets/ref_2.png`。
- 文件节点的 `file` 字段会被改写成实际解压路径。
- 所有节点 id 和连线 id 都会被重新生成。

## 外部生成检查清单

从外部工具生成 `.bragi` 时，按这个清单做：

1. 创建一个 ZIP 文件，然后把扩展名改成 `.bragi`。
2. 在 ZIP 根目录放 `canvas.json`。
3. 建议在 ZIP 根目录放 `manifest.json`。
4. 把图片、视频、音频、Markdown 等资源放在 `assets/` 下。
5. `canvas.json` 里的文件节点和分组背景都指向 `assets/...` 路径。
6. 确保每个节点 id 在 `canvas.json` 内唯一。
7. 确保每个连线 id 在 `canvas.json` 内唯一。
8. 确保每条连线的 `fromNode` 和 `toNode` 都能找到对应节点。
9. 如果要作为 Bragi 生成输入，使用指向目标节点的有向连线，并设置 `toEnd: "arrow"`。
10. 不要写绝对本地路径，例如 `/Users/...` 或 `C:\...`。
11. 不要写 `bragiGenerating` 这类运行中状态字段。
12. 优先使用简单的 `assets/<filename>` 路径；嵌套目录可以用，但建议单独测试。
13. 同时测试两种导入方式：
    - 合并到当前打开的画布。
    - 作为新画布导入。

## 导入行为细节

### 合并到当前画布

Bragi 会：

1. 把资源解压到 `_bragi/assets`。
2. 改写文件节点和分组背景路径。
3. 重新生成所有导入节点和连线的 id，避免和当前画布冲突。
4. 把连线的 `fromNode` 和 `toNode` 改写成新的节点 id。
5. 把导入的节点整体移动到当前画布内容右侧，并留出 200 px 间距。
6. 把导入节点和连线追加到当前画布。

### 作为新画布导入

Bragi 会：

1. 把资源解压到 `_bragi/assets`。
2. 改写文件节点和分组背景路径。
3. 重新生成所有节点和连线的 id。
4. 用 `.bragi` 文件名创建新的 `.canvas` 文件。
5. 如果同名画布已存在，会追加 `_1`、`_2` 这样的后缀。
6. 打开新创建的画布。

## 当前限制

- 当前导入器不会校验 `manifest.json`。
- 当前导入器没有完整 schema validation。
- 当前只会自动改写 `node.file` 和 `node.background`。
- 导入时总会重新生成节点 id，所以任何存了节点 id 的自定义字段都不会被自动重映射。
- 资源文件重名时会自动加后缀，但自定义字段里的路径不会跟着更新。
- 如果 `canvas.json` 引用了 `assets/` 里的某个文件，但 ZIP 里实际没有这个文件，导入可能完成，但文件节点会变成断开的引用。
