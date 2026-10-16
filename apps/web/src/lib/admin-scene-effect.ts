import type { ConversationId, RoomId, Scene, SceneId } from '@dramatis/core';

export interface AdminSceneTarget {
  roomId: RoomId;
  worldTitle: string;
  conversationId: ConversationId;
  conversationTitle: string;
  sceneId: SceneId;
  sceneTitle: string;
}
export interface AdminSceneEffect {
  target: AdminSceneTarget;
  scene: Scene;
  sceneWritten: true;
  activeLinked: boolean;
}
