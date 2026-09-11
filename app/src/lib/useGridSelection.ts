// Row selection for a DataGridPro list with bulk actions. Isolates the MUI X
// v7 selection-model shape and clears the selection whenever the list's
// scope changes (bucket, lane) or after an action lands — a bulk action must
// never fire on rows that are no longer on screen.

import { useCallback, useEffect, useState } from 'react';
import type { GridRowSelectionModel } from '@mui/x-data-grid-pro';

export function useGridSelection(resetKeys: unknown[]) {
  const [model, setModel] = useState<GridRowSelectionModel>([]);
  const selected = model.map(String);
  const clear = useCallback(() => setModel([]), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setModel([]); }, resetKeys);
  return {
    selected,
    gridProps: {
      checkboxSelection: true as const,
      disableRowSelectionOnClick: true as const,
      rowSelectionModel: model,
      onRowSelectionModelChange: (m: GridRowSelectionModel) => setModel(m),
    },
    clear,
  };
}
