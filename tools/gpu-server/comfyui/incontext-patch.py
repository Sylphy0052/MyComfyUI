"""comfyui-anima-incontextのref_attn_opを、ComfyUI 8d534945 (2026-09-27) 以降のattn_op呼び出しに合わせる。

8d534945以降、ComfyUIはattn_opへpreferred_attentionを渡し、q/k/vをAttentionTensorContainerで
包んで渡すことがある。ノード側の差し替え関数はtransformer_optionsと素のTensorしか想定していない。
追加のキーワード引数はfallbackへそのまま渡し、Containerは形の判定ではpeek()、自前でattentionを
計算するときはtake()で中のTensorを取り出す。
"""

from pathlib import Path

path = Path("/ComfyUI/custom_nodes/comfyui-anima-incontext/incontext.py")
src = path.read_text()
MARK = "# patched: AttentionTensorContainer"

old_head = """    def ref_attn_op(q_B_S_H_D, k_B_S_H_D, v_B_S_H_D, transformer_options={}):
        if (
            not state.active
            or state.bias_B is None
            or k_B_S_H_D.shape[1] != state.total_tokens
            or q_B_S_H_D.shape[1] != state.total_tokens
        ):
            return fallback_op(q_B_S_H_D, k_B_S_H_D, v_B_S_H_D, transformer_options=transformer_options)
"""
new_head = (
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
if MARK in src:
    print("already patched")
else:
    assert src.count(old_head) == 1, "unexpected source"
    path.write_text(src.replace(old_head, new_head))
    print("patched")
