"""comfyui-anima-incontextのref_attn_opを、ComfyUI 8d534945 (2026-09-27) 以降のattn_op呼び出しに合わせる。

8d534945以降、ComfyUIはattn_opへpreferred_attentionを渡し、q/k/vをAttentionTensorContainerで
包んで渡すことがある。ノード側の差し替え関数はtransformer_optionsと素のTensorしか想定していない。
追加のキーワード引数はfallbackへそのまま渡し、Containerは形の判定ではpeek()、自前でattentionを
計算するときはtake()で中のTensorを取り出す。
"""

from pathlib import Path

TARGET = Path("/ComfyUI/custom_nodes/comfyui-anima-incontext/incontext.py")
MARK = "# patched: AttentionTensorContainer"

OLD_HEAD = """    def ref_attn_op(q_B_S_H_D, k_B_S_H_D, v_B_S_H_D, transformer_options={}):
        if (
            not state.active
            or state.bias_B is None
            or k_B_S_H_D.shape[1] != state.total_tokens
            or q_B_S_H_D.shape[1] != state.total_tokens
        ):
            return fallback_op(q_B_S_H_D, k_B_S_H_D, v_B_S_H_D, transformer_options=transformer_options)
"""
NEW_HEAD = (
    """    def ref_attn_op(q_B_S_H_D, k_B_S_H_D, v_B_S_H_D, transformer_options={}, **kwargs):
        """
    + MARK
    + """
        def _peek(t):
            return t.peek() if hasattr(t, "peek") else t

        if (
            not state.active
            or state.bias_B is None
            or _peek(k_B_S_H_D).shape[1] != state.total_tokens
            or _peek(q_B_S_H_D).shape[1] != state.total_tokens
        ):
            return fallback_op(q_B_S_H_D, k_B_S_H_D, v_B_S_H_D, transformer_options=transformer_options, **kwargs)

        q_B_S_H_D, k_B_S_H_D, v_B_S_H_D = (
            t.take() if hasattr(t, "take") else t for t in (q_B_S_H_D, k_B_S_H_D, v_B_S_H_D)
        )
"""
)


def main() -> None:
    src = TARGET.read_text()
    if MARK in src:
        print("already patched")
        return
    assert src.count(OLD_HEAD) == 1, "unexpected source"
    TARGET.write_text(src.replace(OLD_HEAD, NEW_HEAD))
    print("patched")


if __name__ == "__main__":
    main()
