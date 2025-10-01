import { ToCData } from '../types'

/**
 * Adds a "path" property to each node in the graph data
 * showing its location in the data structure
 */
export function addNodePaths(data: ToCData): ToCData {
  const dataWithPaths = JSON.parse(JSON.stringify(data)) // Deep clone to avoid mutations
  
  dataWithPaths.sections.forEach((section: any, sectionIndex: number) => {
    section.columns.forEach((column: any, columnIndex: number) => {
      if (!column || !column.nodes) return
      
      column.nodes.forEach((node: any, nodeIndex: number) => {
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
  
  cleanedData.sections.forEach((section: any) => {
    section.columns.forEach((column: any) => {
      if (!column || !column.nodes) return
      
      column.nodes.forEach((node: any) => {
        if (!node) return
        
        // Remove the path property
        delete node.path
      })
    })
  })
  
  return cleanedData
}