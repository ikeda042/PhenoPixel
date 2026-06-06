# PhenoPixel

PhenoPixel は、顕微鏡画像からの細胞抽出とバッチ解析のためのバックエンド + フロントエンドアプリである。バックエンドは `/api/v1` 配下に API を公開し、フロントエンドは各種ワークフローを実行するための UI を提供する。

以下のモンタージュは、2 つの蛍光チャンネルを GFP / mCherry 風の二重染色として重ねた、細胞集団のオーバーレイ例である。fluo1 を Magenta、fluo2 を Green としてスケールバーなしで合成し、各細胞タイルの表示輝度はサチュレーションしない範囲で見やすく揃えている。

![Manual Label 1 Overlay Fluo montage](docs/images/manual-label1-overlay-fluo-montage.png)

![Manual Label 1 Replot montage](docs/images/manual-label1-replot-montage.png)

![細胞抽出プレビュー](docs/screen-records/cell-extraction.preview.gif)

## ND2 マネージャー

このページでは ND2 ファイルを管理する。新しいデータセットのアップロード、既存データセットの削除、そして細胞抽出に進むための特定の ND2 ファイルの選択を行える。

![ND2 マネージャー](docs/screenshots/nd2manager1.png)

## 細胞抽出

1. 抽出設定を行う。選択した ND2 ファイルに対して、Canny アルゴリズムのパラメータ、ROI の切り出しサイズ、蛍光レイヤー数、Auto Annotation のオン / オフを設定する。`Extract cells` を押すと抽出処理が開始される。

![細胞抽出設定](docs/screenshots/cell_extraction1.png)

2. 自動アノテーションの挙動。`Auto Annotation` が `On` のとき、抽出後に追加の後処理ステップが実行され、単一細胞候補とデブリ / 結合細胞を自動的に分離する。

通常は `backend/autoannotation/artifacts/autoannotator.pkl` に同梱された教師ありモデルを使う。このモデルは、単一の参照用 SQLite DB `backend/autoannotation/testdata/autoannotation_testdata.db`（合計 520 cells、`1` が 300、`N/A` が 220）から学習されている。特徴量には輪郭の area、perimeter、convexity、solidity、PCA、Hu moments と、PH / Fluo 画像の輪郭内外の輝度、contrast、edge density を使う。weighted kNN と L2 logistic regression の ensemble を 5-fold CV で選び、F1 `0.9608`、accuracy `0.9538`、precision `0.9423`、recall `0.9800` だった。

モデルファイルを読み込めない場合や特徴抽出に失敗した場合は、輪郭のみに基づく従来のヒューリスティックへ fallback する。別モデルを使う場合は `PHENOPIXEL_AUTOANNOTATION_MODEL=/path/to/autoannotator.pkl` を指定できる。fallback では、輪郭 `C = {(x_i, y_i)}_{i=1}^N` が抽出されると、バックエンドは 2 つの幾何学的スコアを計算し、その両方がしきい値を満たした場合にのみ `Label 1` を付与する。

まず、主軸に直交する方向における輪郭の太さを測定する。以下を定義する。

$$
\Sigma_C =
\frac{1}{N-1}
\sum_{i=1}^{N}
(\mathbf{p}_i - \bar{\mathbf{p}})
(\mathbf{p}_i - \bar{\mathbf{p}})^{\mathsf{T}},
\qquad
\mathbf{p}_i = (x_i, y_i)^{\mathsf{T}}.
$$

`Σ_C` の固有値を `λ₁ ≥ λ₂` とすると、自動アノテーションは小さい方の `λ₂` を幅 / 横方向への広がりの代理指標として用い、次を満たす輪郭のみを受理する。

$$
\lambda_2 \le 120.
$$

次に、輪郭の凸性を周長比から測定する。`P(C)` を輪郭周長、`P(Hull(C))` をその凸包の周長とすると、コード内では次を定義している。

$$
\kappa(C) = \frac{P(\mathrm{Hull}(C))}{P(C)}.
$$

不規則なデブリや結合した物体は、その凸包よりも輪郭周長がかなり長くなる傾向があるため、`κ` は小さくなる。この輪郭は、次を満たす場合にのみ受理する。

$$
\kappa(C) > 0.85.
$$

最終的な自動アノテーションスコアは次のように書ける。

$$
s(C) = \mathbf{1}[\lambda_2 \le 120] \, \mathbf{1}[\kappa(C) > 0.85].
$$

fallback では `s(C) = 1` のときに `Label 1` を付与し、それ以外では `N/A` を付与する。つまり、横方向にコンパクトで、かつ凸形状に近い輪郭を保持し、幅が広い・ギザギザしている・デブリらしい形状を手動レビュー前に除外する。

![自動アノテーション処理](docs/screenshots/cell_extraction2.png)

3. 結果を確認して次に進む。抽出が完了すると、右パネルに全フレームにわたる抽出済み細胞輪郭が表示される。ここから生成された細胞データベースを開くか、細胞ラベリング（アノテーション）ページへ移動できる。輪郭がうまく抽出されていない場合（たとえば Canny パラメータが適切でない場合）は、パラメータ調整セクションで設定を見直し、`Re-extract` をクリックして再度抽出を実行する。

![抽出結果と次の操作](docs/screenshots/cell_extraction3.png)

## データベースマネージャー

この画面には細胞抽出で生成された細胞データベースが一覧表示される。ここではデータベースのアップロードやダウンロードができ、実験のデータベースを単一ファイルとしてシステムから切り離して扱うことができる。

![データベースマネージャー](docs/screenshots/database_manager1.png)

特定の細胞データベース行で `Access` をクリックすると、個々の細胞ごとの情報を確認できるページに移動する。

![データベースアクセス](docs/screenshots/database_manager2.png)

機能パネルには次の表示モードがある。
- `Contour`: 抽出された輪郭のみを表示する。
- `Replot`: 保存済みデータから現在のプロットを再描画する。
- `Overlay`: デフォルト画像の上に輪郭を重ねて表示する。
- `Overlay Raw`: 生画像の上に輪郭を重ねて表示する。
- `Overlay Fluo`: 蛍光画像の上に輪郭を重ねて表示する。
- `Heatmap`: シグナル強度をヒートマップとして可視化する。
- `Map 256`: 256 段階のマップ表示を描画する。
- `Map Raw`: ネイティブのピクセル解像度でマップ表示を描画する。
- `Distribution`: 選択した細胞または領域の値分布を表示する。

![機能パネルのモード](docs/screenshots/database_manager3.png)

## アノテーション

自動検出された輪郭には、デブリや結合細胞（単一細胞ではないもの）が含まれることがあるため、これらを手動で除外する必要がある。

![アノテーションのクリーンアップ](docs/screenshots/annotation1.png)

`Label 1`（右パネル）を付けるには、対象となる細胞（単一細胞）をクリックするか、Shift + ドラッグで複数細胞を選択してから `Apply` を押す。右パネルのラベルはリアルタイムで更新される。`Label 1` を `N/A` に戻すこともでき、逆方向のラベリングにも対応している。

![アノテーションによるラベリング](docs/screenshots/annotation2.png)

![複数細胞へのアノテーション](docs/screenshots/annotation3.png)

## バルクエンジン

アノテーション後のデータベースでは、左パネルにデフォルトの `Label 1` が付与された細胞が表示される。デブリや単一細胞でないものが混ざっている場合は、アノテーションページに戻って再ラベル付けする必要がある。単一細胞のみがラベル付けされた状態になれば、この集団に対してバッチ解析を実行できる。

![バルクエンジンでの選択](docs/screenshots/bulk1.png)

![バルクエンジンでの解析](docs/screenshots/bulk2.png)

バルクエンジンで利用できるバッチ解析モードは次のとおりである。
- `Cell length`: 輪郭から細胞長（um）を測定する。
- `Cell area`: 細胞面積（px^2）を計算する。
- `Normalized median`: 選択したチャネルについて、細胞ごとの正規化中央値強度を計算する。
- `FITC aggregation ratio`: FITC シグナルの凝集比を計算する。
- `Entropy`: エントロピー（1 - sparsity）を用いて強度分布を定量化する。
- `Heatmap`: 選択したチャネルのヒートマップベクトル / プロットを生成する。
- `Contours`: 整列済み輪郭を可視化し、輪郭座標をエクスポートする。
- `Map256`: 細胞群にまたがる Map256 ストリップを描画する。
- `Raw data`: 各輪郭内の生の強度値をエクスポートする。

生の強度データを含む JSON エクスポートにも対応している。

![バルクエンジンの解析モード](docs/screenshots/bulk3.png)

たとえば `Heatmap` モードでは、選択したラベルの全細胞について GFP の局在を 1 枚のプロットに集約して可視化できる。

![バルクエンジンのヒートマップ例](docs/screenshots/bulk4.png)

## 手法

PhenoPixel の定量ルーチンは、共通の単一細胞解析パイプラインに従う。すなわち、位相差画像から輪郭を検出し、細胞固有の座標系で細胞を再パラメータ化し、細胞間で直接比較可能な形状記述子や蛍光記述子を計算する。`C = {(x_i, y_i)}_{i=1}^n` を 1 細胞の輪郭点、`Ω_C` をその輪郭内部のピクセル集合とする。

### 1. 輪郭抽出、主軸、基底変換

輪郭は Canny ベースのパイプラインにより位相差画像から抽出される。主たる伸長軸は輪郭座標の共分散から推定され、

$$
\Sigma =
\begin{pmatrix}
\mathrm{Var}[X_1] & \mathrm{Cov}[X_1, X_2] \\
\mathrm{Cov}[X_1, X_2] & \mathrm{Var}[X_2]
\end{pmatrix},
$$

主方向は次の解として与えられる。

$$
\mathbf{w}^* = \underset{\|\mathbf{w}\| = 1}{\mathrm{arg\,max}} \mathbf{w}^{\mathsf{T}} \Sigma \mathbf{w},
\qquad
\Sigma \mathbf{w} = \lambda \mathbf{w}.
$$

`Q = (v₁ v₂)` を正規直交固有ベクトル基底とすると、座標は次により細胞整列座標系へ変換される。

$$
\mathbf{u} = Q^{\mathsf{T}} \mathbf{x},
\qquad
\mathbf{x} = Q \mathbf{u}.
$$

これにより任意の画像回転の影響が除去され、曲がった細胞や糸状細胞も解析的に扱いやすくなる。

`Q` は正規直交行列であるため、この基底変換ではユークリッド長も保存される。任意のベクトル `x` と、その変換後座標 `u = Qᵀx` について、

$$
\|\mathbf{u}\|^2
= \mathbf{u}^{\mathsf{T}}\mathbf{u}
= (Q^{\mathsf{T}}\mathbf{x})^{\mathsf{T}} (Q^{\mathsf{T}}\mathbf{x})
= \mathbf{x}^{\mathsf{T}} Q Q^{\mathsf{T}} \mathbf{x}
= \mathbf{x}^{\mathsf{T}} \mathbf{x}
= \|\mathbf{x}\|^2,
$$

`QᵀQ = QQᵀ = I` であるため、基底変換の前後で測定される距離は同一である。

### 2. 中心線フィッティングと細胞長

整列座標系では、細胞中心線は `k` 次多項式で近似する。

$$
\hat{f}(u_1) = \theta^{\mathsf{T}} \phi(u_1),
\qquad
\theta = (W^{\mathsf{T}} W)^{-1} W^{\mathsf{T}} f.
$$

曲がった細胞について、学位論文での定式化では、細胞長は輪郭と中心線の 2 つの交点の間の弧長として定義する。

$$
L = \int_{u_{1,a}}^{u_{1,b}}
\sqrt{1 + (\frac{d\hat{f}}{du_1})^2}\,du_1.
$$

![中心線フィッティング](docs/images/method-centerline-fit.png)

現在のバックエンド実装では、`Cell length` は輪郭内部ピクセルのロバスト PCA による主軸方向の広がりとして返され、固定ピクセルサイズ `0.065 μm/px` を用いて換算する。

$$
L_{\mathrm{API}} \approx (\max_i \pi_i - \min_i \pi_i) \times 0.065.
$$

### 3. 細胞面積と生ピクセルのエクスポート

細胞面積は輪郭で囲まれた面積

$$
A(C) = \iint_{\Omega_C} 1\,dA,
$$

として表され、抽出時に保存されて `Cell area` により報告される。`Raw data` は選択チャネルに対する未集約の強度集合

$$
\{ I(p) \mid p \in \Omega_C \}
$$

をエクスポートする。

### 4. 中心線に沿った蛍光ベクトル化

細胞内ピクセル `(p_i, q_i)` とその強度 `G(p_i, q_i)` ごとに、フィッティングされた中心線上の最近点を次で求める。

$$
u_{1,i}^* = \underset{u_1 \in [u_{1,a}, u_{1,b}]}{\mathrm{arg\,min}}
[(u_1 - p_i)^2 + (\hat{f}(u_1) - q_i)^2].
$$

この位置は弧長に変換される。

$$
\ell(u_1) = \int_{u_{1,a}}^{u_1} \sqrt{1 + (\hat{f}'(t))^2}\,dt,
\qquad
\ell_i^* = \ell(u_{1,i}^*).
$$

固定次元の記述子を得るために、弧長区間 `[0, L]` を `n` 個のビンに分割し、各ビンで max-pooling を行う。

$$
g_j = \max \{ G(p_i, q_i) \mid \ell_i^* \in I_j \}.
$$

投影されたピクセルが `I_j` に 1 つも入らない場合は `g_j = 0` とする。こうして得られる固定長の局在ベクトルは

$$
\mathbf{g} = (g_1, \dots, g_n)^{\mathsf{T}}.
$$

である。現在の実装では `n = 35`、多項式次数のデフォルト値は `k = 4` である。`Heatmap` は、これらのピークベクトルを絶対長座標または相対位置座標のいずれかで可視化する。

![ピークベクトルヒートマップの構築](docs/images/method-peak-vectorization.png)

### 5. 正規化中央値と凝集系スコア

選択した任意のチャネルについて、細胞内部の強度は細胞ごとの最大値で正規化される。

$$
\tilde{I}_i = \frac{I_i}{\max_{p \in \Omega_C} I(p)},
\qquad
m(C) = \mathrm{median}(\tilde{I}_i).
$$

このスカラー値は `Normalized median` として報告される。集団レベルの凝集スコアは次のように書ける。

$$
R(\tau) = \frac{1}{N} \sum_{c=1}^{N} \mathbf{1}[m(C_c) < \tau].
$$

現在の `FITC aggregation ratio` プロットは、この形式をデフォルトのカットオフ `τ = 0.7414` で用いている。学位論文の実験では、同じ正規化中央値の考え方が IbpA-GFP および TorA-GFP の異常局在判定にも使われており、それらのデータセットでは `m ≤ 0.6` がしきい値の例として用いられている。

### 6. 学位論文固有の表現型判定

HU-GFP compaction については、まず 35 ビンのピークベクトルを計算し、それを

$$
s(C) = \sum_{j=1}^{35} g_j.
$$

として要約する。

対照集団を用いて、異常性のしきい値は 5 パーセンタイルにより定義する。

$$
\tau_{\mathrm{HU}} = Q_{0.05}(\{ s(C_c^{\mathrm{ctrl}}) \}),
$$

HU aggregation ratio は `s(C) < τ_HU` を満たす細胞の割合である。

PI permeability については、細胞内 PI 強度の平均を

$$
\mu(C) = \frac{1}{|\Omega_C|} \sum_{p \in \Omega_C} I_{\mathrm{PI}}(p),
$$

とし、対照由来の陽性しきい値を

$$
\tau_{\mathrm{PI}} = Q_{0.95}(\{ \mu(C_c^{\mathrm{ctrl}}) \}).
$$

と定義する。PI 陽性率は、`μ(C) > τ_PI` を満たす細胞の比率である。

## 要件

- Python 3.x（起動には `python3.14` を使用）
- Node.js と npm（フロントエンドの開発 / ビルド用）
- SQLite（バックエンドで使用。細胞抽出で生成されるデータベース）

## クイックスタート

バックエンド:

```sh
python3.14 -m venv venv
source ./venv/bin/activate
cd backend
pip install -r requirements.txt
python main.py
```

フロントエンド:

```sh
cd frontend
npm install
npm run dev
```

- バックエンド: http://localhost:3000
- フロントエンド開発サーバー: http://localhost:3001

## ローカル URL

- API ベース: http://localhost:3000/api/v1
- Swagger UI（OpenAPI）: http://localhost:3000/api/v1/docs
- OpenAPI JSON: http://localhost:3000/api/v1/openapi.json
- ヘルスチェック: http://localhost:3000/api/v1/health

## Docker デプロイ（Traefik）

`docker/compose.yaml` を使って Traefik + バックエンドを起動する。

1. `backend/.env` を作成する（`backend/.env.template` を参照）
2. `SERVER_HOST` と `TRAEFIK_ACME_EMAIL` を設定する
3. 起動する:

```sh
cd docker
docker compose -f compose.yaml up -d --build
```

Traefik は `80/443` を使用する。`SERVER_HOST` に設定したホスト名へアクセスすると、API は `/api/v1` 配下で公開される。

## 技術スタック

バックエンド:

<p align="left">
  <a href="https://fastapi.tiangolo.com/" title="FastAPI">
    <img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/fastapi/fastapi-original.svg" height="32" alt="FastAPI" />
  </a>
  <a href="https://www.sqlalchemy.org/" title="SQLAlchemy">
    <img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/sqlalchemy/sqlalchemy-original.svg" height="32" alt="SQLAlchemy" />
  </a>
  <a href="https://numpy.org/" title="NumPy">
    <img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/numpy/numpy-original.svg" height="32" alt="NumPy" />
  </a>
  <a href="https://opencv.org/" title="OpenCV">
    <img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/opencv/opencv-original.svg" height="32" alt="OpenCV" />
  </a>
  <a href="https://matplotlib.org/" title="Matplotlib">
    <img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/matplotlib/matplotlib-original.svg" height="32" alt="Matplotlib" />
  </a>
</p>

- API レイヤーには FastAPI、Uvicorn、Pydantic を使用
- SQLite アクセスには SQLAlchemy を使用
- 画像処理と描画には NumPy、OpenCV、Matplotlib を使用

フロントエンド:

<p align="left">
  <a href="https://react.dev/" title="React">
    <img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/react/react-original.svg" height="32" alt="React" />
  </a>
  <a href="https://vitejs.dev/" title="Vite">
    <img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/vite/vite-original.svg" height="32" alt="Vite" />
  </a>
  <a href="https://www.typescriptlang.org/" title="TypeScript">
    <img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/typescript/typescript-original.svg" height="32" alt="TypeScript" />
  </a>
  <a href="https://chakra-ui.com/" title="Chakra UI">
    <img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/chakraui/chakraui-original.svg" height="32" alt="Chakra UI" />
  </a>
</p>

- UI には React + React Router を使用
- 開発 / ビルドツールには Vite を使用
- スタイリングとモーションには Chakra UI と Framer Motion を使用

## ドキュメント

- バルクエンジン API: [backend/app/bulk_engine/README.md](backend/app/bulk_engine/README.md)
- 細胞抽出 API: [backend/app/cellextraction/README.md](backend/app/cellextraction/README.md)
- フロントエンド: [frontend/README.md](frontend/README.md)

## ライセンス

PhenoPixel は MIT License の下で公開されています。詳細は [LICENSE](LICENSE) を参照してください。
サードパーティ依存関係は、それぞれのライセンスに従います。
