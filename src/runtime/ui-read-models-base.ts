type Listener = () => void;

export interface UiReadModel<TSnapshot> {
  getSnapshot(): TSnapshot;
  subscribe(listener: Listener): () => void;
}
