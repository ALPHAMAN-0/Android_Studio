import { useState } from "react";
import { toast } from "sonner";
import { Topbar } from "@/components/layout/topbar";
import { FileGrid } from "@/components/files/file-grid";
import { FilePreview } from "@/components/files/file-preview";
import { useFavorites } from "@/hooks/use-files";
import * as db from "@/lib/services/database";
import { deleteMessage } from "@/lib/services/telegram";
import { getSettings } from "@/lib/services/settings";
import { sanitizeName } from "@/lib/utils";
import type { FileItem } from "@/types";

export function FavoritesPage() {
  const { files, mutate } = useFavorites();
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);

  const handleToggleFavorite = async (fileId: string, isFavorite: boolean) => {
    await db.updateFile(fileId, { isFavorite });
    mutate();
  };

  const handleDeleteFile = async (fileId: string) => {
    const file = await db.deleteFile(fileId);
    if (file) {
      const settings = await getSettings();
      if (settings?.botToken && settings?.channelId) {
        deleteMessage(file.telegramMessageId, settings.botToken, settings.channelId).catch(() => {});
      }
      toast.success("File deleted");
    }
    mutate();
  };

  const handleRenameFile = async (fileId: string, currentName: string) => {
    const raw = prompt("Rename file:", currentName);
    const newName = raw ? sanitizeName(raw) : null;
    if (!newName) { if (raw !== null) toast.error("Invalid file name"); return; }
    if (newName !== currentName) {
      await db.updateFile(fileId, { originalName: newName });
      mutate();
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <Topbar title="Favorites" />

      <div className="flex-1 overflow-y-auto pb-16 animate-fade-in">
        <FileGrid
          files={files}
          folders={[]}
          onToggleFavorite={handleToggleFavorite}
          onDeleteFile={handleDeleteFile}
          onRenameFile={handleRenameFile}
          onFileClick={setPreviewFile}
        />
      </div>

      {previewFile && (
        <FilePreview
          file={previewFile}
          files={files}
          onClose={() => setPreviewFile(null)}
          onNavigate={setPreviewFile}
          onToggleFavorite={handleToggleFavorite}
        />
      )}
    </div>
  );
}
