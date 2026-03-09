import Foundation
import SwiftUI

struct MarkdownRenderer {
    static func render(_ text: String) -> AttributedString {
        // Try SwiftUI's built-in markdown parser first
        if let attributed = try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
            return attributed
        }
        return AttributedString(text)
    }
}
