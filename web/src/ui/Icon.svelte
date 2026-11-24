<!-- A line icon, drawn in the text's color; decorative: the button or
link that holds it carries the name. -->
<script lang="ts" module>
const PATHS = {
  comment: "M4 5h16v11H9l-5 4z",
  pen: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  delete: "M6 6l12 12M18 6L6 18",
  share:
    "M16 8a3 3 0 1 0-2.8-4M8 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm8 6a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM10.6 10.7l2.8-1.4M10.6 13.3l2.8 1.4",
  file: "M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5M9 13h6M9 17h6",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  check: "M5 12l5 5 9-10",
  left: "M15 5l-7 7 7 7",
  right: "M9 5l7 7-7 7",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  history: "M12 7v5l3 2M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4",
  outline: "M4 6h16M8 12h12M8 18h12",
  key: "M11 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM11 12h10M17 12v3M20 12v3",
  verified: "M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6zM9 12l2 2 4-4",
  unverified: "M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6zM12 8v5M12 16h.01",
  signIn: "M14 4h5v16h-5M3 12h12M11 8l4 4-4 4",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  bulletList: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
  orderedList: "M10 6h10M10 12h10M10 18h10M4 4h1v4M4 14h2l-2 4h2",
  taskList: "M3 5h5v5H3zM12 7h9M12 17h9M3 16l2 2 3-4",
  insert: "M12 5v14M5 12h14",
  collapse: "M6 15l6-6 6 6",
  format: "M4 7V5h11v2M9.5 5v14M7.5 19h4M14 12h7M17.5 12v7",
  help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17h.01",
} as const;
export type IconName = keyof typeof PATHS;
</script>

<script lang="ts">
interface Props {
  name: IconName;
}
const { name }: Props = $props();
</script>

<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d={PATHS[name]} /></svg>

<style>
  .icon {
    width: 18px;
    height: 18px;
    flex: none;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
