/**
 * Focus View と管理画面で共用するアイコン。
 *
 * 同じ操作に同じ絵を当てるために 1 箇所に置く。画面ごとに描き分けると、
 * 「集中中に押したあのボタン」が一覧のどれなのか毎回読み直すことになる。
 *
 * 既定は 15px。管理画面の行内など小さく使う場所では `size` で縮める。
 */

interface IconProps {
  size?: number;
}

/** 完了。他と紛れないよう、これだけは線で描いたチェック */
export const CheckIcon = ({ size = 15 }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="3"
  >
    <path d="M4.5 12.5l5 5 10-11" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** 待ち。砂時計 — 止まっているのではなく、相手の時間が動いている状態 */
export const WaitIcon = ({ size = 15 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M6.5 3h11v1.7h-1.2v2.1L12 11l-4.3-4.2V4.7H6.5zm1.2 18v-1.7h1.2v-2.1L12 13l4.3 4.2v2.1h1.2V21zM9 4.7v1.4l3 2.9 3-2.9V4.7z" />
  </svg>
);

/** メモ。折り目のある紙 */
export const NoteIcon = ({ size = 15 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M6 3h8.5L19 7.5V21H6zm8 1.6V8h3.4zM8.4 11h7.2v1.5H8.4zm0 3.4h7.2V16H8.4zm0 3.4h4.8v1.5H8.4z" />
  </svg>
);

/**
 * サブタスク。幹から 2 本枝が出て、その先にタスクの四角がぶら下がる形。
 *
 * 三角形は同じ大きさの再生ボタンと紛れるうえ、「この下に内訳がある」ことを
 * 絵で示せない。枝の先を線のままにすると今度はただの記号に見えるので、
 * ぶら下がっているのが「タスク」だと分かる形にしてある。
 */
export const SubtaskIcon = ({ size = 19 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24">
    <path
      d="M6 3.5v5h4M6 3.5v14.2h4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <rect x="10" y="5.8" width="8.6" height="5.4" rx="1.7" fill="currentColor" />
    <rect x="10" y="15" width="8.6" height="5.4" rx="1.7" fill="currentColor" />
  </svg>
);
