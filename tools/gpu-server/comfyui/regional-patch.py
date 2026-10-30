"""Comfyui-Anima-Regional-Conditioningを、ComfyUI 8d534945 (2026-09-27) 以降のattn_op呼び出しに合わせ、
self-attentionのmaskだけを早く切る入力を足す。

1. 8d534945以降、ComfyUIはattn_opへpreferred_attentionを渡し、q/k/vをAttentionTensorContainerで
   包んで渡すことがある。ノードの_masked_attn_opは素のTensorしか想定していないので、追加のキーワード
   引数を受け取って捨て、Containerはtake()で中のTensorを取り出す（自前のSDPAで計算するため）。
2. self-attentionのmaskを後半まで当てると、領域の境目に縦の継ぎ目が出る。cross-attentionのmaskは
   後半まで当てないと髪飾りのような細部が人物に結び付かない。任意入力self_end_percentを足し、
   self-attentionのmaskだけをそこで切る。省略時（-1）はend_percentと同じで、元の動作のまま。
   end_percentより大きい値はend_percentとして扱う（cross-attentionのmaskを切った後にselfだけ残すことはしない）。
"""

from pathlib import Path

TARGET = Path("/ComfyUI/custom_nodes/Comfyui-Anima-Regional-Conditioning/nodes.py")
MARK = "# patched: AttentionTensorContainer, self_end_percent"

REPLACEMENTS = [
    (
        """    attn_bias: Optional[torch.Tensor] = None,
) -> torch.Tensor:
""",
        """    attn_bias: Optional[torch.Tensor] = None,
    **kwargs,
) -> torch.Tensor:
    """
        + MARK
        + """
""",
    ),
    (
        """    B, Sq, H, D = q.shape
""",
        """    # torch.Tensorにもtake(index)があるので、hasattrでなく型で判定する
    q, k, v = (t if torch.is_tensor(t) else t.take() for t in (q, k, v))
    B, Sq, H, D = q.shape
""",
    ),
    (
        """        return low <= sigma <= high
""",
        """        return low <= sigma <= high

    def self_active(self, transformer_options: dict) -> bool:
        sigmas = transformer_options.get("sigmas", None)
        if sigmas is None or not torch.is_tensor(sigmas) or sigmas.numel() == 0:
            return True
        return float(sigmas.max().detach().cpu().item()) >= self.self_end_sigma
""",
    ),
    (
        """    if patch.self_mask_strength > 0.0:
        cond_self_bias""",
        """    if patch.self_mask_strength > 0.0 and patch.self_active(transformer_options):
        cond_self_bias""",
    ),
    (
        """                "background_conditioning": ("CONDITIONING",),
            },""",
        """                "background_conditioning": ("CONDITIONING",),
                "self_end_percent": (
                    "FLOAT",
                    {"default": -1.0, "min": -1.0, "max": 1.0, "step": 0.001},
                ),
            },""",
    ),
    (
        """        background_conditioning=None,
    ):
        _validate_anima_model(model)""",
        """        background_conditioning=None,
        self_end_percent=-1.0,
    ):
        _validate_anima_model(model)""",
    ),
    (
        """            background_conditioning,
        )

        patched_model = model.clone()""",
        """            background_conditioning,
        )
        patch.self_end_sigma = (
            end_sigma
            if self_end_percent < 0
            else float(model_sampling.percent_to_sigma(min(self_end_percent, end_percent)))
        )

        patched_model = model.clone()""",
    ),
]


def main() -> None:
    source = TARGET.read_text(encoding="utf-8")
    if MARK in source:
        print(f"already patched: {TARGET}")
        return
    for old, new in REPLACEMENTS:
        if source.count(old) != 1:
            raise SystemExit(
                f"想定した箇所が1つでない ({source.count(old)}): {old[:60]!r}"
            )
        source = source.replace(old, new)
    TARGET.write_text(source, encoding="utf-8")
    print(f"patched: {TARGET}")


if __name__ == "__main__":
    main()
