import { ToCData } from '../types'

// Narrow shapes used internally after JSON.parse(JSON.stringify(...)) round-trip.
// Typed loosely (path lives outside Node) so we can attach/delete the property
// without fighting the exact ToCData shape.
interface NodeWithPath {
  path?: string
  [key: string]: unknown
}
interface ColumnWithNodes {
  nodes?: NodeWithPath[]
}
interface SectionWithColumns {
  columns: ColumnWithNodes[]
}

/**
 * Adds a "path" property to each node in the graph data
 * showing its location in the data structure
 */
export function addNodePaths(data: ToCData): ToCData {
  const dataWithPaths = JSON.parse(JSON.stringify(data)) // Deep clone to avoid mutations

  dataWithPaths.sections.forEach((section: SectionWithColumns, sectionIndex: number) => {
    section.columns.forEach((column, columnIndex) => {
      if (!column || !column.nodes) return

      column.nodes.forEach((node, nodeIndex) => {
        if (!node) return

        // Add the path property to each node
        node.path = `sections.${sectionIndex}.columns.${columnIndex}.nodes.${nodeIndex}`
      })
    })
  })

  return dataWithPaths
}

/**
 * Removes the "path" property from each node in the graph data
 * This is useful for cleaning the data before saving/exporting
 */
export function removeNodePaths(data: ToCData): ToCData {
  const cleanedData = JSON.parse(JSON.stringify(data)) // Deep clone

  cleanedData.sections.forEach((section: SectionWithColumns) => {
    section.columns.forEach((column) => {
      if (!column || !column.nodes) return

      column.nodes.forEach((node) => {
        if (!node) return

        // Remove the path property
        delete node.path
      })
    })
  })

  return cleanedData
}
